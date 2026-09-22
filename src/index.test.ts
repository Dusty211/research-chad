import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REFERENCE_AVAILABLE_CONTEXT } from "./lib/budget.js";
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
  generate?: {
    text(input: {
      model: { providerID: string; id: string };
      prompt: string;
    }): Promise<{ text: string }>;
  };
  tool: {
    transform(
      callback: (editor: ToolEditor) => void,
    ): Promise<{ dispose(): Promise<void> }>;
  };
};

/** Base dir shared by all test options; drilldown reads resolve into it. */
const TEST_BASE_DIR = join(tmpdir(), "research-chad-test-base");

/** Valid plugin options pointing at a throwaway TOC. */
function makeOptions(tocPath: string): unknown {
  return {
    tocPath,
    baseDir: TEST_BASE_DIR,
    availableContext: REFERENCE_AVAILABLE_CONTEXT,
    model: { providerID: "test", id: "test-model" },
  };
}

/** A GenerateCtx whose model always returns the given text. */
function fakeModel(text: string): PluginCtx["generate"] {
  return { text: async () => ({ text }) };
}

/** A GenerateCtx that returns each response in sequence (last one repeats). */
function fakeModelSequence(responses: string[]): PluginCtx["generate"] {
  let i = 0;
  return {
    text: async () => ({
      text: responses[Math.min(i++, responses.length - 1)],
    }),
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
function loadPlugin(
  options: unknown,
  modelText = "[]", // default: no relevant entries
  generate?: PluginCtx["generate"],
): Map<string, CapturedTool> {
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
    generate: generate ?? fakeModel(modelText),
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
  let tocPath: string;
  /** A TOC with one entry so a stage-1 chunk call actually happens. */
  let tocWithEntryPath: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-test-"));
    tocPath = join(tmp, "TOC.yaml");
    await writeFile(tocPath, "projects: []\n", "utf8");
    tocWithEntryPath = join(tmp, "TOC-entry.yaml");
    await writeFile(
      tocWithEntryPath,
      `projects:\n  - dir: projects/alpha\n    docs:\n      - name: garden.md\n        summary: [Garden notes]\n`,
      "utf8",
    );
    // The drilldown stage reads candidate files from disk; the one entry in
    // tocWithEntryPath resolves into TEST_BASE_DIR.
    await mkdir(join(TEST_BASE_DIR, "projects", "alpha", "docs"), {
      recursive: true,
    });
    await writeFile(
      join(TEST_BASE_DIR, "projects", "alpha", "docs", "garden.md"),
      "Garden notes about growing tomatoes.",
      "utf8",
    );
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(TEST_BASE_DIR, { recursive: true, force: true });
  });

  it("registers exactly two tools with pinned schemas", () => {
    const tools = loadPlugin(makeOptions(tocPath));
    expect(Array.from(tools.keys()).sort()).toEqual(["toc_scan", "toc_search"]);

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

  it("toc_scan surfaces a PipelineError as code 'pipeline' at the tool boundary", async () => {
    // The model returns invalid JSON; generateChecked retries once with the
    // identical prompt and fails again — the standard path to a ModelOutputError,
    // which the pool wraps in a PipelineError. This pins that the documented
    // top-level code "pipeline" actually reaches the tool result.
    const tools = loadPlugin(makeOptions(tocWithEntryPath), "this is not json");
    const result = await tools.get("toc_scan")!.execute({ query: "garden" });
    const parsed = JSON.parse(result.content) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("pipeline");
    expect(parsed.error.message).toContain("Pipeline failed: 1 of 1");
  });

  it("toc_search surfaces a PipelineError as code 'pipeline' at the tool boundary", async () => {
    // Same standard failure path, through the search tool (stage-1 chunk call
    // returns invalid JSON twice -> ModelOutputError -> PipelineError).
    const tools = loadPlugin(makeOptions(tocWithEntryPath), "this is not json");
    const result = await tools.get("toc_search")!.execute({ query: "garden" });
    const parsed = JSON.parse(result.content) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("pipeline");
  });

  it("registers hard-error tools when options are invalid", async () => {
    const tools = loadPlugin({});
    expect(Array.from(tools.keys()).sort()).toEqual(["toc_scan", "toc_search"]);

    for (const name of ["toc_scan", "toc_search"]) {
      const result = await tools.get(name)!.execute({ query: "anything" });
      const parsed = JSON.parse(result.content) as {
        ok: boolean;
        error: { code: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("options");
    }
  });

  describe("tool input validation", () => {
    const invalidInputs: Array<[string, unknown]> = [
      ["missing query", {}],
      ["non-string query", { query: 42 }],
      ["empty string query", { query: "" }],
      ["null input", null],
      ["non-object input", "garden"],
    ];

    for (const [name, input] of invalidInputs) {
      it(`rejects ${name} with code 'invalid_input' on both tools`, async () => {
        const tools = loadPlugin(makeOptions(tocWithEntryPath));
        for (const toolName of ["toc_scan", "toc_search"]) {
          const result = await tools.get(toolName)!.execute(input);
          const parsed = JSON.parse(result.content) as {
            ok: boolean;
            error: { code: string };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("invalid_input");
        }
      });
    }
  });

  // TOC entry paths are resolved against baseDir at parse time, so the model
  // must echo the absolute path for a hit to survive stage-1 dedup.
  const gardenEntryPath = join(
    TEST_BASE_DIR,
    "projects",
    "alpha",
    "docs",
    "garden.md",
  );

  it("toc_scan returns a JSON array of hits on success", async () => {
    const modelJson = JSON.stringify([
      {
        path: gardenEntryPath,
        matchReason: "Garden notes. On topic. Relevant to query.",
      },
    ]);
    const tools = loadPlugin(makeOptions(tocWithEntryPath), modelJson);
    const result = await tools.get("toc_scan")!.execute({ query: "garden" });
    const hits = JSON.parse(result.content) as Array<{
      path: string;
      depth: string;
    }>;
    expect(Array.isArray(hits)).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(gardenEntryPath);
    expect(hits[0].depth).toBe("toc");
  });

  it("toc_search returns a JSON array of drilldown hits on success", async () => {
    // Stage-1 chunk call, then the stage-2 drill call for the one candidate.
    const chunkJson = JSON.stringify([
      {
        path: gardenEntryPath,
        matchReason: "Garden notes. On topic. Relevant to query.",
      },
    ]);
    const drillJson = JSON.stringify({
      match: true,
      matchReason: "Garden notes. On topic. Relevant.",
    });
    const tools = loadPlugin(
      makeOptions(tocWithEntryPath),
      "",
      fakeModelSequence([chunkJson, drillJson]),
    );
    const result = await tools.get("toc_search")!.execute({ query: "garden" });
    const hits = JSON.parse(result.content) as Array<{
      path: string;
      depth: string;
    }>;
    expect(Array.isArray(hits)).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(gardenEntryPath);
    expect(hits[0].depth).toBe("drilldown");
  });
});
