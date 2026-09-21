import { readFile } from "node:fs/promises";
import { PipelineError } from "../errors.js";
import { chunkBudgetBytes } from "../lib/budget.js";
import { sliceFile } from "../lib/chunk.js";
import {
  buildDrillFoldPrompt,
  buildDrillPartPrompt,
  buildDrillPrompt,
} from "../lib/prompt.js";
import {
  parseDrillPartResult,
  parseDrillResult,
  toHit,
} from "../lib/validate.js";
import type { ChadOptions } from "../options.js";
import type { Hit, TocEntry } from "../types.js";
import {
  attemptedCount,
  mapWithConcurrency,
  toFailures,
} from "./concurrency.js";
import { generateChecked, type GenerateCtx } from "./model.js";

/**
 * Stage 2: for each candidate entry, read its file and judge relevance.
 * The entry's path (resolved at parse time) is the identity — no lookup.
 * Files within budget get one call; larger files run the left-to-right
 * overflow fold. Returns hits at depth "drilldown".
 *
 * Independent candidates run through the concurrency pool (opts.inferenceConcurrency
 * / inferenceRateLimitMs). All-or-nothing: any candidate failure raises a
 * PipelineError listing every failed candidate. The overflow fold within a
 * single candidate stays sequential — it threads a running distill forward,
 * a true dependency chain, not parallelizable work. Per-item outcomes are
 * exposed so a future retry/recovery policy can re-dispatch only the failed
 * candidates without changing the pool or loop structure.
 */
export async function runDrill(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  candidates: TocEntry[],
): Promise<Hit[]> {
  const maxBytes = chunkBudgetBytes(opts.availableContext);

  const outcomes = await mapWithConcurrency(
    candidates,
    {
      concurrency: opts.inferenceConcurrency,
      rateLimitMs: opts.inferenceRateLimitMs,
    },
    (entry) => drillOne(ctx, opts, query, entry, maxBytes),
  );

  const failures = toFailures(outcomes);
  if (failures.length > 0) {
    throw new PipelineError(
      failures,
      candidates.length,
      attemptedCount(outcomes),
    );
  }

  const hits: Hit[] = [];
  for (const outcome of outcomes) {
    if (!outcome || !outcome.ok) continue;
    if (outcome.value !== null) hits.push(outcome.value);
  }
  return hits;
}

/** Read one candidate and judge it. Returns a hit, or null when not relevant. */
async function drillOne(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  entry: TocEntry,
  maxBytes: number,
): Promise<Hit | null> {
  const text = await readFile(entry.path, "utf8"); // ENOENT → failure naming the path

  const result =
    text.length <= maxBytes
      ? await generateChecked(
          ctx,
          opts.model,
          buildDrillPrompt(query, text),
          parseDrillResult,
        )
      : await drillOverflow(ctx, opts, query, text, maxBytes);

  return result.match ? toHit(entry, result) : null;
}

/** Left-to-right reduce over parts, threading the running distill forward. */
async function drillOverflow(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  text: string,
  maxBytes: number,
): Promise<{ match: boolean; matchReason: string | null }> {
  const sliced = sliceFile(text, maxBytes);
  if (!sliced.ok) throw sliced.error;

  const evidence: string[] = [];
  let distill: string | null = null;

  for (const part of sliced.value) {
    const partResult = await generateChecked(
      ctx,
      opts.model,
      buildDrillPartPrompt(query, part, distill),
      parseDrillPartResult,
    );
    if (partResult.relevant && partResult.evidence !== null) {
      evidence.push(partResult.evidence);
      distill = evidence.join(" ");
    }
  }

  return generateChecked(
    ctx,
    opts.model,
    buildDrillFoldPrompt(query, evidence),
    parseDrillResult,
  );
}
