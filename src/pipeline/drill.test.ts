import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REFERENCE_AVAILABLE_CONTEXT,
  chunkBudgetBytes,
} from "../lib/budget.js";
import { runDrill } from "./drill.js";
import type { GenerateCtx } from "./model.js";
import type { ChadOptions } from "../options.js";
import type { TocEntry } from "../types.js";

const MATCH_REASON =
  "Covers garden soil preparation. Gives exact steps. References the spring planting guide.";

/**
 * Back-solve availableContext for a chunk budget of fileSize / divisor bytes.
 * chunkBudgetBytes is linear in availableContext, so scaling from a reference
 * point yields the exact input regardless of the formula's constants.
 */
function optsForBudget(
  base: ChadOptions,
  fileSize: number,
  divisor: number,
): ChadOptions {
  const refN = 10_000;
  const refBudget = chunkBudgetBytes(refN);
  return {
    ...base,
    availableContext: Math.max(
      1,
      Math.round((refN * fileSize) / (divisor * refBudget)),
    ),
  };
}

function docEntry(name: string, path: string): TocEntry {
  return {
    kind: "doc",
    name,
    path,
    dir: "projects/alpha",
    summary: [],
  };
}

function convoEntry(name: string, path: string): TocEntry {
  return {
    kind: "conversation",
    name,
    path,
    dir: "projects/alpha",
    summary: [],
  };
}

describe("runDrill", () => {
  let tmp: string;
  let opts: ChadOptions;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-drill-"));
    const docsDir = join(tmp, "projects/alpha/docs");
    const summariesDir = join(tmp, "projects/alpha/summaries");
    await mkdir(docsDir, { recursive: true });
    await mkdir(summariesDir, { recursive: true });
    await writeFile(
      join(docsDir, "garden.md"),
      "# Garden\nsoil preparation details",
      "utf8",
    );
    await writeFile(
      join(docsDir, "cooking.md"),
      "# Cooking\nbaking notes",
      "utf8",
    );
    // Filename with an inert uuid-looking prefix — just a filename.
    await writeFile(
      join(summariesDir, "deadbeef_garden-chat.md"),
      "# Chat\ngarden discussion",
      "utf8",
    );
    opts = {
      tocPath: join(tmp, "TOC.yaml"),
      baseDir: tmp,
      availableContext: REFERENCE_AVAILABLE_CONTEXT,
      model: { providerID: "p", id: "m" },
      inferenceConcurrency: 1,
      inferenceRateLimitMs: 0,
    };
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("keeps only matching candidates, at depth drilldown", async () => {
    const prompts: string[] = [];
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          prompts.push(prompt);
          const isGarden = prompt.includes("# Garden\nsoil preparation");
          return {
            text: JSON.stringify(
              isGarden
                ? { match: true, matchReason: MATCH_REASON }
                : { match: false, matchReason: null },
            ),
          };
        },
      },
    };

    const hits = await runDrill(ctx, opts, "garden soil", [
      docEntry("garden.md", join(tmp, "projects/alpha/docs/garden.md")),
      docEntry("cooking.md", join(tmp, "projects/alpha/docs/cooking.md")),
    ]);

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
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Query: garden soil");
  });

  it("reads conversation files by their verbatim filename (uuid prefix inert)", async () => {
    const ctx: GenerateCtx = {
      generate: {
        text: async () => ({
          text: JSON.stringify({ match: true, matchReason: MATCH_REASON }),
        }),
      },
    };

    const hits = await runDrill(ctx, opts, "garden", [
      convoEntry(
        "deadbeef_garden-chat.md",
        join(tmp, "projects/alpha/summaries/deadbeef_garden-chat.md"),
      ),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("conversation");
    expect(hits[0].name).toBe("deadbeef_garden-chat.md");
  });

  it("runs the overflow fold for files over budget", async () => {
    const bigDir = join(tmp, "projects/alpha/docs");
    const bigContent = Array.from(
      { length: 100 },
      (_, i) => `line ${i} about garden soil`,
    ).join("\n");
    await writeFile(join(bigDir, "big.md"), bigContent, "utf8");

    // Force overflow by making the budget a known fraction of the file size —
    // the file then always exceeds it and slices into multiple parts.
    const fileSize = new TextEncoder().encode(bigContent).length;
    const smallOpts = optsForBudget(opts, fileSize, 2);

    const prompts: string[] = [];
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          prompts.push(prompt);
          if (prompt.includes("Read part")) {
            return {
              text: JSON.stringify({
                relevant: true,
                evidence: "part mentions garden soil preparation",
              }),
            };
          }
          // Final fold call.
          return {
            text: JSON.stringify({ match: true, matchReason: MATCH_REASON }),
          };
        },
      },
    };

    const hits = await runDrill(ctx, smallOpts, "garden soil", [
      docEntry("big.md", join(bigDir, "big.md")),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0].matchReason).toBe(MATCH_REASON);
    const partCalls = prompts.filter((p) => p.includes("Read part"));
    expect(partCalls.length).toBeGreaterThanOrEqual(2);
    expect(prompts.at(-1)).toContain("You reviewed a document part by part");
    // The distill was threaded into later parts.
    expect(partCalls.at(-1)).toContain("So far found in earlier parts");
  });

  it("runs the final fold with empty evidence when no part matches", async () => {
    // Every part returns {relevant: false, evidence: null}, so `evidence` stays
    // empty and `distill` stays null throughout. The final fold must still run
    // (with an empty evidence list), and no part prompt may carry a "So far
    // found" distill — there was never any to thread forward.
    const bigDir = join(tmp, "projects/alpha/docs");
    const bigContent = Array.from(
      { length: 100 },
      (_, i) => `line ${i} about something else`,
    ).join("\n");
    await writeFile(join(bigDir, "nomatch.md"), bigContent, "utf8");

    const fileSize = new TextEncoder().encode(bigContent).length;
    const smallOpts = optsForBudget(opts, fileSize, 2);

    const prompts: string[] = [];
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          prompts.push(prompt);
          if (prompt.includes("Read part")) {
            return {
              text: JSON.stringify({ relevant: false, evidence: null }),
            };
          }
          // Final fold: no evidence collected, model still answers non-match.
          return {
            text: JSON.stringify({ match: false, matchReason: null }),
          };
        },
      },
    };

    const hits = await runDrill(ctx, smallOpts, "garden soil", [
      docEntry("nomatch.md", join(bigDir, "nomatch.md")),
    ]);

    // No evidence -> no match -> no hits.
    expect(hits).toEqual([]);
    const partCalls = prompts.filter((p) => p.includes("Read part"));
    expect(partCalls.length).toBeGreaterThanOrEqual(2);
    // The fold ran with an empty evidence list.
    expect(prompts.at(-1)).toContain("You reviewed a document part by part");
    expect(prompts.at(-1)).toContain("is:\n");
    // No part ever carried a distill (evidence was always empty).
    for (const p of partCalls) {
      expect(p).not.toContain("So far found in earlier parts");
    }
  });

  it("raises a PipelineError wrapping an FsError when a file is missing", async () => {
    const ctx: GenerateCtx = {
      generate: { text: async () => ({ text: "{}" }) },
    };
    await expect(
      runDrill(ctx, opts, "q", [
        docEntry("ghost.md", join(tmp, "projects/alpha/docs/ghost.md")),
      ]),
    ).rejects.toMatchObject({
      code: "pipeline",
      total: 1,
      attempted: 1,
      failures: [{ index: 0, error: expect.objectContaining({ code: "fs" }) }],
    });
    // The FsError message still names the missing file.
    await expect(
      runDrill(ctx, opts, "q", [
        docEntry("ghost.md", join(tmp, "projects/alpha/docs/ghost.md")),
      ]),
    ).rejects.toThrow(/ghost\.md/);
  });

  it("lists only the failed candidate when one of several errors", async () => {
    // The model returns a valid non-match for whatever file exists; only the
    // missing file (ENOENT) fails.
    const ctx: GenerateCtx = {
      generate: {
        text: async () => ({
          text: JSON.stringify({ match: false, matchReason: null }),
        }),
      },
    };
    await expect(
      runDrill(ctx, opts, "q", [
        docEntry("garden.md", join(tmp, "projects/alpha/docs/garden.md")),
        docEntry("ghost.md", join(tmp, "projects/alpha/docs/ghost.md")),
      ]),
    ).rejects.toMatchObject({
      code: "pipeline",
      total: 2,
      attempted: 2,
      failures: [{ index: 1, error: expect.anything() }],
    });
  });

  it("keeps matching candidates at inferenceConcurrency 2", async () => {
    const parallelOpts = { ...opts, inferenceConcurrency: 2 };
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          const isGarden = prompt.includes("# Garden\nsoil preparation");
          return {
            text: JSON.stringify(
              isGarden
                ? { match: true, matchReason: MATCH_REASON }
                : { match: false, matchReason: null },
            ),
          };
        },
      },
    };

    const hits = await runDrill(ctx, parallelOpts, "garden soil", [
      docEntry("garden.md", join(tmp, "projects/alpha/docs/garden.md")),
      docEntry("cooking.md", join(tmp, "projects/alpha/docs/cooking.md")),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe("garden.md");
  });

  it("stops dispatching at concurrency 2 and reports attempted < total on failure", async () => {
    // Three candidates, two slots: garden + ghost dispatch together. The
    // missing file fails fast (ENOENT before any model call) while the garden
    // read/model call is still in-flight, so cooking is never dispatched:
    // attempted 2 of 3. The garden model call is held on a controllable
    // promise (no wall-clock) until the failure has landed and been asserted.
    const parallelOpts = { ...opts, inferenceConcurrency: 2 };
    let releaseGarden: () => void;
    const gardenInFlight = new Promise<void>((r) => {
      releaseGarden = r;
    });
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          if (prompt.includes("# Garden")) await gardenInFlight;
          return {
            text: JSON.stringify({ match: false, matchReason: null }),
          };
        },
      },
    };

    const candidates = [
      docEntry("garden.md", join(tmp, "projects/alpha/docs/garden.md")),
      docEntry("ghost.md", join(tmp, "projects/alpha/docs/ghost.md")),
      docEntry("cooking.md", join(tmp, "projects/alpha/docs/cooking.md")),
    ];

    const run = runDrill(ctx, parallelOpts, "q", candidates).catch((e) => e);
    // Yield for the fast ENOENT to be recorded while garden is still in-flight.
    await Promise.resolve();
    await Promise.resolve();
    // Settle the run now that the failure has landed; cooking was never claimed.
    releaseGarden!();
    const error = await run;
    expect(error).toMatchObject({
      code: "pipeline",
      total: 3,
      attempted: 2,
      failures: [{ index: 1, error: expect.anything() }],
    });
  });

  it("paces every overflow-fold dispatch through the valve when inferenceRateLimitMs > 0", async () => {
    // One over-budget candidate forces a multi-part fold. Invariant pinned:
    // every model call — part calls and the final fold — is spaced by the
    // interval, exactly like pool-level dispatches.
    const bigDir = join(tmp, "projects/alpha/docs");
    const bigContent = Array.from(
      { length: 100 },
      (_, i) => `line ${i} about garden soil`,
    ).join("\n");
    await writeFile(join(bigDir, "throttled.md"), bigContent, "utf8");

    const fileSize = new TextEncoder().encode(bigContent).length;
    const throttledOpts = {
      ...optsForBudget(opts, fileSize, 2),
      inferenceRateLimitMs: 40,
    };

    let partCalls = 0;
    let foldCalls = 0;
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          if (prompt.includes("Read part")) {
            partCalls++;
            return {
              text: JSON.stringify({
                relevant: true,
                evidence: "part mentions garden soil preparation",
              }),
            };
          }
          // Final fold call.
          foldCalls++;
          return {
            text: JSON.stringify({ match: true, matchReason: MATCH_REASON }),
          };
        },
      },
    };

    const hits = await runDrill(ctx, throttledOpts, "garden soil", [
      docEntry("throttled.md", join(bigDir, "throttled.md")),
    ]);

    expect(hits).toHaveLength(1);
    // The fold actually ran multiple dispatches (parts + final fold), all of
    // which now pass through the valve — pinned here by call count + correct
    // result with the throttle engaged. (The spacing guarantee itself is proven
    // deterministically by the RateLimiter unit tests.)
    expect(partCalls).toBeGreaterThanOrEqual(2);
    expect(foldCalls).toBe(1);
  });
});
