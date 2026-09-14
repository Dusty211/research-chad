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

/** Minimal mock of the plugin context: captures whatever the plugin registers via ctx.tool.transform. */
function mockCtx() {
  const tools = new Map<string, CapturedTool>();
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
        callback(editor);
        return { dispose: async () => {} };
      },
    },
  };
  return { tools, ctx };
}

describe("research-chad plugin", () => {
  let tmp: string;
  let fixturePath: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-test-"));
    fixturePath = join(tmp, "fixture.txt");
    await writeFile(fixturePath, "hello verbatim\nsecond line", "utf8");
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("registers a read_verbatim tool with a required path input", async () => {
    const { ctx, tools } = mockCtx();
    (plugin as unknown as { setup(ctx: PluginCtx): void }).setup(ctx);

    const tool = tools.get("read_verbatim");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/no truncation/i);
    const schema = tool!.input as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["path"]);
    expect(schema.properties.path).toEqual({ type: "string" });
  });

  it("reads a file and returns its full content", async () => {
    const { ctx, tools } = mockCtx();
    (plugin as unknown as { setup(ctx: PluginCtx): void }).setup(ctx);

    const result = await tools
      .get("read_verbatim")!
      .execute({ path: fixturePath });
    expect(result.content).toBe("hello verbatim\nsecond line");
  });
});
