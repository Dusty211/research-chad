import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEntries, runStage1 } from "./stage1.js";
import type { GenerateCtx } from "./model.js";
import type { ChadOptions } from "../options.js";
import type { TocEntry } from "../types.js";

const REASON = "Covers garden planning. Lists soil steps. Directly on query.";

function docEntry(name: string, path: string): TocEntry {
  return { kind: "doc", name, path, dir: "projects/alpha", summary: [] };
}

/** A GenerateCtx whose model returns the given JSON text for every call. */
function ctxReturning(jsonText: string, calls?: string[]): GenerateCtx {
  return {
    generate: {
      text: async ({ prompt }) => {
        calls?.push(prompt);
        return { text: jsonText };
      },
    },
  };
}

describe("loadEntries", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-stage1-"));
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("reads and parses the TOC into entries", async () => {
    const tocPath = join(tmp, "TOC.yaml");
    await writeFile(
      tocPath,
      `
projects:
  - dir: projects/alpha
    docs:
      - name: garden.md
        summary: [Garden notes]
`,
      "utf8",
    );
    const opts: ChadOptions = {
      tocPath,
      baseDir: tmp,
      availableContext: 262_144,
      model: { providerID: "p", id: "m" },
      inferenceConcurrency: 1,
      inferenceRateLimitMs: 0,
    };

    const entries = await loadEntries(opts);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      kind: "doc",
      name: "garden.md",
      path: join(tmp, "projects/alpha/docs/garden.md"),
      dir: "projects/alpha",
      summary: ["Garden notes"],
    });
  });

  it("throws a TocParseError for malformed TOC yaml", async () => {
    const tocPath = join(tmp, "bad.yaml");
    await writeFile(tocPath, "projects: [unclosed", "utf8");
    const opts: ChadOptions = {
      tocPath,
      baseDir: tmp,
      availableContext: 262_144,
      model: { providerID: "p", id: "m" },
      inferenceConcurrency: 1,
      inferenceRateLimitMs: 0,
    };

    await expect(loadEntries(opts)).rejects.toMatchObject({
      code: "toc_parse",
    });
  });

  it("rejects with ENOENT when the TOC file is missing (raw fs error, not wrapped)", async () => {
    const opts: ChadOptions = {
      tocPath: join(tmp, "does-not-exist.yaml"),
      baseDir: tmp,
      availableContext: 262_144,
      model: { providerID: "p", id: "m" },
      inferenceConcurrency: 1,
      inferenceRateLimitMs: 0,
    };

    // readFile runs before parseToc, so a missing file surfaces as the raw
    // fs ENOENT, not a TocParseError.
    await expect(loadEntries(opts)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("runStage1", () => {
  let tmp: string;
  let opts: ChadOptions;
  const gardenPath = "/abs/projects/alpha/docs/garden.md";
  const cookingPath = "/abs/projects/alpha/docs/cooking.md";
  const entries: TocEntry[] = [
    docEntry("garden.md", gardenPath),
    docEntry("cooking.md", cookingPath),
  ];

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-stage1-run-"));
    opts = {
      tocPath: join(tmp, "TOC.yaml"), // unused by runStage1 (entries passed in)
      baseDir: tmp,
      availableContext: 262_144, // budget ~200KB: everything fits one chunk
      model: { providerID: "p", id: "m" },
      inferenceConcurrency: 1,
      inferenceRateLimitMs: 0,
    };
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns deduped {entry, matchReason} pairs for relevant entries", async () => {
    const ctx = ctxReturning(
      JSON.stringify([
        { path: gardenPath, matchReason: REASON },
        {
          path: cookingPath,
          matchReason: "Baking basics. On query. Relevant.",
        },
      ]),
    );

    const hits = await runStage1(ctx, opts, "garden", entries);
    expect(hits).toEqual([
      { entry: entries[0], matchReason: REASON },
      {
        entry: entries[1],
        matchReason: "Baking basics. On query. Relevant.",
      },
    ]);
  });

  it("ignores paths the model echoes that are not in the TOC", async () => {
    const ctx = ctxReturning(
      JSON.stringify([
        { path: "/nonexistent/phantom.md", matchReason: REASON },
      ]),
    );

    const hits = await runStage1(ctx, opts, "ghost", entries);
    expect(hits).toEqual([]);
  });

  it("returns [] when the model reports nothing relevant", async () => {
    const ctx = ctxReturning("[]");
    const hits = await runStage1(ctx, opts, "nothing", entries);
    expect(hits).toEqual([]);
  });

  it("dedupes a path echoed twice within one chunk (keeps first matchReason)", async () => {
    const ctx = ctxReturning(
      JSON.stringify([
        { path: gardenPath, matchReason: "First reason. Kept. Wins." },
        { path: gardenPath, matchReason: "Second reason. Dropped. Loses." },
      ]),
    );

    const hits = await runStage1(ctx, opts, "garden", entries);
    expect(hits).toHaveLength(1);
    expect(hits[0].matchReason).toBe("First reason. Kept. Wins.");
  });

  it("dedupes across chunks, keeping the first occurrence in chunk order", async () => {
    // Force a 2-chunk split: with empty summaries the entry blocks are 49/50 bytes
    // (see renderEntryBlock), so a 61-byte budget (tokens=80 -> floor(80*3.5*0.218))
    // fits the first block but not both.
    const multiOpts = { ...opts, availableContext: 80 };
    const calls: string[] = [];
    const ctx = ctxReturning(
      JSON.stringify([
        // Both chunks echo the same two paths; dedup must collapse to one each.
        { path: gardenPath, matchReason: "Chunk reason A. First. Kept." },
        { path: cookingPath, matchReason: "Cooking A. First. Kept." },
      ]),
      calls,
    );

    const hits = await runStage1(ctx, multiOpts, "garden", entries);

    // Primary invariant: the split actually produced multiple independent chunk
    // calls (assert on observed count, not an assumed exact split, so a budget or
    // block-rendering change can't silently collapse this to one call).
    expect(calls.length).toBeGreaterThan(1);
    // One hit per unique entry, first-occurrence matchReason wins.
    expect(hits).toEqual([
      { entry: entries[0], matchReason: "Chunk reason A. First. Kept." },
      { entry: entries[1], matchReason: "Cooking A. First. Kept." },
    ]);
  });

  it("throws a ChunkBudgetError when an entry exceeds the chunk budget", async () => {
    // A single enormous entry block cannot fit any realistic budget.
    const huge = docEntry("huge.md", "/abs/projects/alpha/docs/huge.md");
    huge.summary = ["x".repeat(10_000)]; // block far over a tiny budget
    const tinyOpts = { ...opts, availableContext: 1 }; // floor(1*3.5*0.218)=0 bytes

    const ctx = ctxReturning("[]");
    await expect(runStage1(ctx, tinyOpts, "q", [huge])).rejects.toMatchObject({
      code: "chunk_budget",
    });
  });

  it("raises a PipelineError wrapping the ModelOutputError when output is invalid twice", async () => {
    // Invalid JSON fails the check on both attempts -> all-or-nothing PipelineError.
    const ctx = ctxReturning("this is not json");
    await expect(runStage1(ctx, opts, "q", entries)).rejects.toMatchObject({
      code: "pipeline",
      failures: [
        { index: 0, error: expect.objectContaining({ code: "model_output" }) },
      ],
      total: 1,
      attempted: 1,
    });
  });

  it("lists every failed chunk in a PipelineError and stops dispatching after the first", async () => {
    // Force a multi-chunk split (same budget trick as the cross-chunk dedup test).
    const multiOpts = { ...opts, availableContext: 80 };
    let call = 0;
    const ctx: GenerateCtx = {
      generate: {
        text: async () => {
          call++;
          // First chunk: valid. Second chunk: invalid JSON (fails both retries).
          return call === 1
            ? {
                text: JSON.stringify([
                  { path: gardenPath, matchReason: REASON },
                ]),
              }
            : { text: "not json at all" };
        },
      },
    };

    await expect(
      runStage1(ctx, multiOpts, "garden", entries),
    ).rejects.toMatchObject({
      code: "pipeline",
      total: 2,
      attempted: 2,
      failures: [
        { index: 1, error: expect.objectContaining({ code: "model_output" }) },
      ],
    });
  });

  it("produces identical deduped results at inferenceConcurrency 2", async () => {
    const parallelOpts = { ...opts, inferenceConcurrency: 2 };
    const ctx = ctxReturning(
      JSON.stringify([
        { path: gardenPath, matchReason: REASON },
        {
          path: cookingPath,
          matchReason: "Baking basics. On query. Relevant.",
        },
      ]),
    );

    const hits = await runStage1(ctx, parallelOpts, "garden", entries);
    expect(hits).toEqual([
      { entry: entries[0], matchReason: REASON },
      {
        entry: entries[1],
        matchReason: "Baking basics. On query. Relevant.",
      },
    ]);
  });

  it("paces dispatches through the rate-limit valve when inferenceRateLimitMs > 0", async () => {
    // Force a 2-chunk split (same budget trick as the cross-chunk dedup test)
    // and turn the throttle on. This pins the wiring: a typo that passed
    // inferenceConcurrency as the interval (or vice versa) would either break
    // the run or fail to space dispatches, and this test catches both.
    const multiOpts = {
      ...opts,
      availableContext: 80,
      inferenceRateLimitMs: 60,
    };
    const dispatchTimes: number[] = [];
    const ctx: GenerateCtx = {
      generate: {
        text: async () => {
          dispatchTimes.push(performance.now());
          return {
            text: JSON.stringify([{ path: gardenPath, matchReason: REASON }]),
          };
        },
      },
    };

    const hits = await runStage1(ctx, multiOpts, "garden", entries);

    // The split actually produced multiple independent chunk calls.
    expect(dispatchTimes.length).toBeGreaterThan(1);
    // Results are still correct under the throttle.
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.path).toBe(gardenPath);
    // Every dispatch — including the first — is spaced by >= the interval.
    const start = dispatchTimes[0];
    for (let i = 1; i < dispatchTimes.length; i++) {
      expect(dispatchTimes[i] - start).toBeGreaterThanOrEqual(i * 60 - 25);
    }
  });
});
