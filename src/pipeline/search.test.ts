import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSearch } from "./search.js";
import type { GenerateCtx } from "./model.js";
import type { ChadOptions } from "../options.js";

const MATCH_REASON =
  "Documents the garden layout. Includes planting schedules. Matches the query directly.";
const SCAN_REASON =
  "Lists garden planning notes. Covers soil preparation. Pertains to the query.";

describe("runSearch", () => {
  let tmp: string;
  let opts: ChadOptions;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-search-"));
    const docsDir = join(tmp, "projects/alpha/docs");
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      join(docsDir, "garden.md"),
      "# Garden\nplanting layout",
      "utf8",
    );
    await writeFile(join(docsDir, "cooking.md"), "# Cooking\nbread", "utf8");

    const tocPath = join(tmp, "TOC.yaml");
    await writeFile(
      tocPath,
      `
projects:
  - name: "alpha"
    dir: projects/alpha
    docs:
      - name: "garden.md"
        summary: ["Garden planting layout"]
      - name: "cooking.md"
        summary: ["Baking bread"]
`,
      "utf8",
    );

    opts = {
      tocPath,
      baseDir: tmp,
      availableContext: 262_144,
      model: { providerID: "p", id: "m" },
    };
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("composes scan then drilldown end to end", async () => {
    const prompts: string[] = [];
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          prompts.push(prompt);
          if (prompt.includes("table of contents extract")) {
            // Stage 1: only garden.md is relevant.
            return {
              text: JSON.stringify([
                {
                  path: join(tmp, "projects/alpha/docs/garden.md"),
                  matchReason: SCAN_REASON,
                },
              ]),
            };
          }
          // Stage 2: drilldown of the candidate.
          return {
            text: JSON.stringify({ match: true, matchReason: MATCH_REASON }),
          };
        },
      },
    };

    const hits = await runSearch(ctx, opts, "garden soil");

    expect(hits).toEqual([
      {
        dir: "projects/alpha",
        path: join(tmp, "projects/alpha/docs/garden.md"),
        name: "garden.md",
        kind: "doc",
        depth: "drilldown",
        matchReason: MATCH_REASON,
      },
    ]);

    // One scan call + one drill call.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("table of contents extract");
    expect(prompts[1]).toContain("# Garden");
  });

  it("returns [] when the scan finds no candidates", async () => {
    const ctx: GenerateCtx = {
      generate: { text: async () => ({ text: "[]" }) },
    };
    const hits = await runSearch(ctx, opts, "nonexistent topic");
    expect(hits).toEqual([]);
  });
});
