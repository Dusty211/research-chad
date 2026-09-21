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
import { mapWithConcurrency, settleAllOrNothing } from "./concurrency.js";
import { readFileChecked } from "./fs.js";
import { generateChecked, type GenerateCtx } from "./model.js";
import { RateLimiter } from "./rate-limiter.js";

/**
 * Stage 2: for each candidate entry, read its file and judge relevance.
 * The entry's path (resolved at parse time) is the identity — no lookup.
 * Files within budget get one call; larger files run the left-to-right
 * overflow fold. Returns hits at depth "drilldown".
 *
 * Independent candidates run through the concurrency pool (opts.inferenceConcurrency);
 * every dispatch additionally passes through the rate-limit valve
 * (opts.inferenceRateLimitMs) — the two are separate concerns composed here, so
 * no candidate is ever sent outside the app faster than the valve allows.
 * All-or-nothing: any candidate failure raises a PipelineError listing every
 * failed candidate (settleAllOrNothing is the single home of that policy).
 * The overflow fold within a single candidate stays sequential — it threads a
 * running distill forward, a true dependency chain, not parallelizable work —
 * but each of its dispatches still passes through the valve.
 */
export async function runDrill(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  candidates: TocEntry[],
): Promise<Hit[]> {
  const maxBytes = chunkBudgetBytes(opts.availableContext);

  // The valve paces every individual dispatch; the pool bounds how many are
  // in-flight. Composed here so neither concern knows about the other.
  const limiter =
    opts.inferenceRateLimitMs > 0
      ? new RateLimiter(opts.inferenceRateLimitMs)
      : null;

  const outcomes = await mapWithConcurrency(
    candidates,
    { concurrency: opts.inferenceConcurrency },
    async (entry) => {
      if (limiter) await limiter.acquire();
      return drillOne(ctx, opts, query, entry, maxBytes, limiter);
    },
  );

  // Past this point every value is a settled Hit | null; undefined (never
  // dispatched) cannot survive settlement.
  const values = settleAllOrNothing(outcomes, candidates.length);

  const hits: Hit[] = [];
  for (const value of values) {
    if (value !== null) hits.push(value);
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
  limiter: RateLimiter | null,
): Promise<Hit | null> {
  const text = await readFileChecked(entry.path); // FsError naming the path

  const result =
    text.length <= maxBytes
      ? await generateChecked(
          ctx,
          opts.model,
          buildDrillPrompt(query, text),
          parseDrillResult,
        )
      : await drillOverflow(ctx, opts, query, text, maxBytes, limiter);

  return result.match ? toHit(entry, result) : null;
}

/**
 * Left-to-right reduce over parts, threading the running distill forward. The
 * fold is sequential (a dependency chain), but every dispatch still passes
 * through the rate-limit valve — no model call leaves the app unthrottled.
 */
async function drillOverflow(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  text: string,
  maxBytes: number,
  limiter: RateLimiter | null,
): Promise<{ match: boolean; matchReason: string | null }> {
  const sliced = sliceFile(text, maxBytes);
  if (!sliced.ok) throw sliced.error;

  const evidence: string[] = [];
  let distill: string | null = null;

  for (const part of sliced.value) {
    if (limiter) await limiter.acquire();
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

  if (limiter) await limiter.acquire();
  return generateChecked(
    ctx,
    opts.model,
    buildDrillFoldPrompt(query, evidence),
    parseDrillResult,
  );
}
