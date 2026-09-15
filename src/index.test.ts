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
  options: unknown;
  tool: {
    transform(
      callback: (editor: ToolEditor) => void,
    ): Promise<{ dispose(): Promise<void> }>;
  };
};

/** Valid plugin options pointing at a throwaway TOC. */
function makeOptions(tocPath: string): unknown {
  return {
    tocPath,
    baseDir: join(tmpdir(), "research-chad-nonexistent-base"),
    availableContext: 262144,
    model: { providerID: "test", id: "test-model" },
  };
}

/**
 * Load the plugin against a mock context and return its registered tools.
 * The double cast is deliberate: Plugin.define() returns an opaque type whose
 * setup() expects the full OpenCode context, but our mock only implements
 * ctx.options and ctx.tool.transform, which is all this plugin uses at setup.
 *
 * NOTE: ctx.tool.transform is fire-and-forget in the real API — it stores the
 * callback and applies it when OpenCode rebuilds its tool registry. The mock
 * therefore captures the callback and replays it here against a local editor,
 * mirroring that rebuild step. Forgetting this replay is how you end up with
 * an empty tool map and no error.
 */
function loadPlugin(options: unknown): Map<string, CapturedTool> {
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
    options,
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
  let tocPath: string;
  // Large enough that any plausible truncation limit (100 chars, 1KB, 10KB)
  // would cut this off — the whole point of read_verbatim is no truncation.
  let largeContent: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-test-"));
    fixturePath = join(tmp, "fixture.txt");
    tocPath = join(tmp, "TOC.yaml");
    largeContent = `line one\n`.repeat(5_000) + "final marker"; // ~60KB
    await writeFile(fixturePath, largeContent, "utf8");
    await writeFile(tocPath, "projects: []\n", "utf8");
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("registers exactly three tools with pinned schemas", () => {
    const tools = loadPlugin(makeOptions(tocPath));
    expect(Array.from(tools.keys()).sort()).toEqual([
      "read_verbatim",
      "toc_scan",
      "toc_search",
    ]);

    const verbatim = tools.get("read_verbatim")!;
    expect(verbatim.description).toMatch(/no truncation/i);
    expect((verbatim.input as { required: string[] }).required).toEqual([
      "path",
    ]);

    for (const name of ["toc_scan", "toc_search"]) {
      const schema = tools.get(name)!.input as {
        type: string;
        required: string[];
        properties: Record<string, unknown>;
      };
      expect(schema.type).toBe("object");
      expect(schema.required).toEqual(["query"]);
      expect(schema.properties.query).toEqual({ type: "string" });
    }
  });

  it("read_verbatim returns the complete file content with no truncation", async () => {
    const tools = loadPlugin(makeOptions(tocPath));
    const result = await tools
      .get("read_verbatim")!
      .execute({ path: fixturePath });

    expect(result.content).toBe(largeContent);
    // Belt and braces: assert the tail survived, which is what truncation would eat first.
    expect(result.content.endsWith("final marker")).toBe(true);
  });

  it("read_verbatim returns a structured error for a missing file", async () => {
    const tools = loadPlugin(makeOptions(tocPath));
    const result = await tools
      .get("read_verbatim")!
      .execute({ path: join(tmp, "nope.txt") });

    const parsed = JSON.parse(result.content) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("unknown"); // raw fs error, not an AppError
  });

  it("toc_scan surfaces a structured error when the TOC has no entries", async () => {
    const tools = loadPlugin(makeOptions(tocPath));
    const result = await tools.get("toc_scan")!.execute({ query: "anything" });

    const parsed = JSON.parse(result.content) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("toc_parse");
  });

  it("registers hard-error tools when options are invalid", async () => {
    const tools = loadPlugin({});
    expect(Array.from(tools.keys()).sort()).toEqual([
      "read_verbatim",
      "toc_scan",
      "toc_search",
    ]);

    const result = await tools.get("toc_scan")!.execute({ query: "anything" });
    const parsed = JSON.parse(result.content) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("options");
  });
});
