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

  it("drills each candidate exactly once even when the model echoes paths across chunks", async () => {
    // Force a multi-chunk stage-1 split so both TOC paths are echoed by more than
    // one independent chunk call. Upstream dedup must collapse them so each file
    // is drilled (and appears in the hits) exactly once — no double-drill.
    // Entry blocks are ~102/93 bytes (path length varies with the tmp dir), summing
    // to ~195; a 152-byte budget (tokens=200 -> floor(200*3.5*0.218)) fits one block
    // but not both, so they split into 2 chunks. The window (max block < budget < sum)
    // is wide enough to absorb tmp-path length variation.
    const multiOpts: ChadOptions = { ...opts, availableContext: 200 };
    const scanPaths = [
      join(tmp, "projects/alpha/docs/garden.md"),
      join(tmp, "projects/alpha/docs/cooking.md"),
    ];
    const prompts: string[] = [];
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          prompts.push(prompt);
          if (prompt.includes("table of contents extract")) {
            // Stage 1: every chunk echoes BOTH paths as relevant.
            return {
              text: JSON.stringify(
                scanPaths.map((path) => ({ path, matchReason: SCAN_REASON })),
              ),
            };
          }
          // Stage 2: drilldown — match whatever file is being read.
          return {
            text: JSON.stringify({ match: true, matchReason: MATCH_REASON }),
          };
        },
      },
    };

    const hits = await runSearch(ctx, multiOpts, "garden soil");

    // Two unique candidates -> exactly two drilldown calls (not one per chunk echo).
    const drillCalls = prompts.filter(
      (p) => !p.includes("table of contents extract"),
    );
    expect(drillCalls).toHaveLength(2);
    // Each candidate appears in the hits exactly once.
    expect(hits).toHaveLength(2);
    const hitPaths = hits.map((h) => h.path).sort();
    expect(hitPaths).toEqual([...scanPaths].sort());
  });
});
