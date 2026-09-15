import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScan } from "./scan.js";
import type { GenerateCtx } from "./model.js";
import type { ChadOptions } from "../options.js";

const REASON =
  "Covers garden planning. Lists soil preparation steps. Directly on query.";

const TOC_YAML = `
projects:
  - name: "alpha"
    dir: projects/alpha
    docs:
      - name: "garden.md"
        summary:
          - "Garden planning notes"
          - "Soil preparation steps"
      - name: "cooking.md"
        summary:
          - "Baking basics"
    conversations:
      - name: "abcd1234_notes.md"
        uuid: abcd1234
        summary:
          - "Inventory of workshop tools"
`;

describe("runScan", () => {
  let tmp: string;
  let opts: ChadOptions;
  let ctx: GenerateCtx;
  let prompts: string[];

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-scan-"));
    const tocPath = join(tmp, "TOC.yaml");
    await writeFile(tocPath, TOC_YAML, "utf8");
    opts = {
      tocPath,
      baseDir: tmp,
      availableContext: 262_144, // budget ~200KB: everything fits one chunk
      model: { providerID: "p", id: "m" },
    };
    prompts = [];
    ctx = {
      generate: {
        text: async ({ prompt }) => {
          prompts.push(prompt);
          // Return only the garden doc as relevant, with a model-written reason.
          return {
            text: JSON.stringify([
              {
                path: `${tmp}/projects/alpha/docs/garden.md`,
                matchReason: REASON,
              },
            ]),
          };
        },
      },
    };
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns toc-depth hits with model-written matchReasons", async () => {
    const hits = await runScan(ctx, opts, "garden soil");

    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      dir: "projects/alpha",
      path: `${tmp}/projects/alpha/docs/garden.md`,
      name: "garden.md",
      kind: "doc",
      depth: "toc",
      matchReason: REASON,
    });
  });

  it("makes one model call per chunk with the explicit prompt", async () => {
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Query: garden soil");
    expect(prompts[0]).toContain(
      `=== DOC: ${tmp}/projects/alpha/docs/garden.md ===`,
    );
    // Conversation header carries the resolved path (filename verbatim).
    expect(prompts[0]).toContain(
      `=== CONVERSATION: ${tmp}/projects/alpha/summaries/abcd1234_notes.md ===`,
    );
    expect(prompts[0]).toMatch(/\{"path":/);
  });

  it("ignores paths the model echoes that are not in the chunk", async () => {
    const liarCtx: GenerateCtx = {
      generate: {
        text: async () => ({
          text: JSON.stringify([
            { path: "/nonexistent/phantom.md", matchReason: REASON },
          ]),
        }),
      },
    };
    const hits = await runScan(liarCtx, opts, "ghost");
    expect(hits).toEqual([]);
  });

  it("splits into multiple chunks when the budget is tiny", async () => {
    // Tiny budget: each entry block gets its own chunk.
    const smallOpts = {
      ...opts,
      availableContext: Math.ceil(130 / (3.5 * 0.218)),
    };
    const callPrompts: string[] = [];
    const multiCtx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          callPrompts.push(prompt);
          return { text: "[]" };
        },
      },
    };

    await runScan(multiCtx, smallOpts, "anything");
    // 3 entries → at least 2 chunks at this budget.
    expect(callPrompts.length).toBeGreaterThanOrEqual(2);
  });
});
