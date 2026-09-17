import { readFile } from "node:fs/promises";
import { chunkBudgetBytes } from "../lib/budget.js";
import { packEntries } from "../lib/chunk.js";
import { parseToc } from "../lib/toc.js";
import { buildChunkPrompt } from "../lib/prompt.js";
import { parseChunkResult } from "../lib/validate.js";
import type { ChadOptions } from "../options.js";
import type { TocEntry } from "../types.js";
import { generateChecked, type GenerateCtx } from "./model.js";

/** A stage-1 relevance judgment: an entry plus the model's reason for it. */
export interface Stage1Hit {
  entry: TocEntry;
  matchReason: string;
}

/** Load and parse the TOC once. Throws the TocParseError on malformed input. */
export async function loadEntries(opts: ChadOptions): Promise<TocEntry[]> {
  const yamlText = await readFile(opts.tocPath, "utf8");
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
 * Hard-fails on first error.
 */
export async function runStage1(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  entries: TocEntry[],
): Promise<Stage1Hit[]> {
  const maxBytes = chunkBudgetBytes(opts.availableContext);
  const packed = packEntries(entries, maxBytes);
  if (!packed.ok) throw packed.error;

  const byPath = new Map(entries.map((e) => [e.path, e]));
  const seen = new Set<string>();
  const hits: Stage1Hit[] = [];

  for (const chunk of packed.value) {
    const chunkHits = await generateChecked(
      ctx,
      opts.model,
      buildChunkPrompt(query, chunk.text),
      parseChunkResult,
    );

    for (const { path, matchReason } of chunkHits) {
      const entry = byPath.get(path);
      if (!entry) continue; // model echoed a path not in the TOC; ignore
      if (seen.has(entry.path)) continue; // already judged; keep first occurrence
      seen.add(entry.path);
      hits.push({ entry, matchReason });
    }
  }

  return hits;
}
