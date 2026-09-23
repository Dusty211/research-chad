import { chunkBudgetBytes } from "../lib/budget.js";
import { packEntries } from "../lib/chunk.js";
import { parseToc } from "../lib/toc.js";
import { buildChunkPrompt } from "../lib/prompt.js";
import { parseChunkResult } from "../lib/validate.js";
import type { ChadOptions } from "../options.js";
import type { TocEntry } from "../types.js";
import { mapWithConcurrency, settleAllOrNothing } from "./concurrency.js";
import { readFileChecked } from "./fs.js";
import { generateChecked, type GenerateCtx } from "./model.js";
import { makeGate, type Clock } from "./rate-limiter.js";

/** A stage-1 relevance judgment: an entry plus the model's reason for it. */
export interface Stage1Hit {
  entry: TocEntry;
  matchReason: string;
}

/** Load and parse the TOC once. Throws FsError on a missing file, TocParseError on malformed input. */
export async function loadEntries(opts: ChadOptions): Promise<TocEntry[]> {
  const yamlText = await readFileChecked(opts.tocPath);
  const toc = parseToc(yamlText, opts.baseDir);
  if (!toc.ok) throw toc.error;
  return toc.value.entries;
}

/**
 * Stage 1: pack entries into budget-sized chunks and run one model call per
 * chunk. Returns the model's relevance judgments deduped by entry path (first
 * occurrence wins, chunk order preserved). The model is non-deterministic and
 * can echo the same path across chunk outputs; deduping here keeps every
 * downstream consumer (scan hits, drilldown candidates) on clean data.
 *
 * Independent chunks run through the concurrency pool (opts.inferenceConcurrency);
 * every dispatch additionally passes through the rate-limit valve
 * (opts.inferenceRateLimitMs) — the two are separate concerns composed here, so
 * no chunk is ever sent outside the app faster than the valve allows.
 * All-or-nothing: any chunk failure raises a PipelineError listing every
 * failed chunk (settleAllOrNothing is the single home of that policy).
 */
export async function runStage1(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  entries: TocEntry[],
  clock?: Clock,
): Promise<Stage1Hit[]> {
  const maxBytes = chunkBudgetBytes(opts.availableContext);
  const packed = packEntries(entries, maxBytes);
  if (!packed.ok) throw packed.error;

  const byPath = new Map(entries.map((e) => [e.path, e]));

  // The valve paces every individual dispatch; the pool bounds how many are
  // in-flight. Composed here so neither concern knows about the other.
  const gate = makeGate(opts.inferenceRateLimitMs, clock);

  const outcomes = await mapWithConcurrency(
    packed.value,
    { concurrency: opts.inferenceConcurrency, gate },
    async (chunk) =>
      generateChecked(
        ctx,
        opts.model,
        buildChunkPrompt(query, chunk.text),
        parseChunkResult,
      ),
  );

  // Past this point every outcome is a success; undefined means the item was
  // never dispatched, which cannot happen once settlement passed.
  const values = settleAllOrNothing(outcomes, packed.value.length);

  const seen = new Set<string>();
  const hits: Stage1Hit[] = [];
  for (const value of values) {
    for (const { path, matchReason } of value) {
      const entry = byPath.get(path);
      if (!entry) continue; // model echoed a path not in the TOC; ignore
      if (seen.has(entry.path)) continue; // already judged; keep first occurrence
      seen.add(entry.path);
      hits.push({ entry, matchReason });
    }
  }

  return hits;
}
