import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./index.js";

type CapturedTool = {
  name: string;
  description?: string;
  input: unknown;
  execute: (input: unknown) => Promise<{ content: string }>;
};

type ToolEditor = {
  add(tool: CapturedTool): void;
  update(id: string, update: (tool: Record<string, unknown>) => void): void;
  remove(id: string): void;
  list(): CapturedTool[];
  get(id: string): CapturedTool | undefined;
  namespace(ns: { name: string; description: string }): void;
};

type PluginCtx = {
  tool: {
    transform(
      callback: (editor: ToolEditor) => void,
    ): Promise<{ dispose(): Promise<void> }>;
  };
};

/**
 * Load the plugin against a mock context and return its registered tools.
 * The double cast is deliberate: Plugin.define() returns an opaque type whose
 * setup() expects the full OpenCode context, but our mock only implements
 * ctx.tool.transform, which is all this plugin uses.
 *
 * NOTE: ctx.tool.transform is fire-and-forget in the real API — it stores the
 * callback and applies it when OpenCode rebuilds its tool registry. The mock
 * therefore captures the callback and replays it here against a local editor,
 * mirroring that rebuild step. Forgetting this replay is how you end up with
 * an empty tool map and no error.
 */
function loadPlugin(): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  let captured: ((editor: ToolEditor) => void) | undefined;
  const editor: ToolEditor = {
    add(tool) {
      tools.set(tool.name, tool);
    },
    update() {},
    remove() {},
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace() {},
  };
  const ctx: PluginCtx = {
    tool: {
      transform: async (callback) => {
        captured = callback;
        return { dispose: async () => {} };
      },
    },
  };
  (plugin as unknown as { setup(ctx: PluginCtx): void }).setup(ctx);
  // Replay the registration, as OpenCode would when rebuilding the registry.
  captured?.(editor);
  return tools;
}

describe("research-chad plugin", () => {
  let tmp: string;
  let fixturePath: string;
  // Large enough that any plausible truncation limit (100 chars, 1KB, 10KB)
  // would cut this off — the whole point of read_verbatim is no truncation.
  let largeContent: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-test-"));
    fixturePath = join(tmp, "fixture.txt");
    largeContent = `line one\n`.repeat(5_000) + "final marker"; // ~60KB
    await writeFile(fixturePath, largeContent, "utf8");
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("registers exactly one tool: read_verbatim, with a required path input", () => {
    const tools = loadPlugin();

    // Pin the full registration surface — no extra tools, no missing ones.
    expect([...tools.keys()]).toEqual(["read_verbatim"]);

    const tool = tools.get("read_verbatim")!;
    expect(tool.description).toMatch(/no truncation/i);

    const schema = tool.input as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["path"]);
    expect(schema.properties.path).toEqual({ type: "string" });
  });

  it("returns the complete file content with no truncation", async () => {
    const tools = loadPlugin();
    const result = await tools
      .get("read_verbatim")!
      .execute({ path: fixturePath });

    expect(result.content).toBe(largeContent);
    // Belt and braces: assert the tail survived, which is what truncation would eat first.
    expect(result.content.endsWith("final marker")).toBe(true);
    expect(result.content.length).toBe(largeContent.length);
  });

  it("rejects when the file does not exist", async () => {
    const tools = loadPlugin();
    await expect(
      tools.get("read_verbatim")!.execute({ path: join(tmp, "nope.txt") }),
    ).rejects.toThrow(/ENOENT/);
  });
});
