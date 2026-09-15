import { readFile } from "node:fs/promises";
import { chunkBudgetBytes } from "../lib/budget.js";
import { packEntries } from "../lib/chunk.js";
import { parseToc } from "../lib/toc.js";
import { buildChunkPrompt } from "../lib/prompt.js";
import { parseChunkResult } from "../lib/validate.js";
import type { ChadOptions } from "../options.js";
import type { Hit, TocEntry } from "../types.js";
import { generateChecked, type GenerateCtx } from "./model.js";
import { runDrill } from "./drill.js";

/** Load and parse the TOC once (shared by scan and search). */
async function loadEntries(opts: ChadOptions): Promise<TocEntry[]> {
  const yamlText = await readFile(opts.tocPath, "utf8");
  const toc = parseToc(yamlText, opts.baseDir);
  if (!toc.ok) throw toc.error;
  return toc.value.entries;
}

/** Stage 1 over a known entry list: chunk plan + one model call per chunk. */
async function scanEntries(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  entries: TocEntry[],
): Promise<TocEntry[]> {
  const maxBytes = chunkBudgetBytes(opts.availableContext);
  const packed = packEntries(entries, maxBytes);
  if (!packed.ok) throw packed.error;

  const byPath = new Map(entries.map((e) => [e.path, e]));
  const candidates: TocEntry[] = [];
  for (const chunk of packed.value) {
    const paths = await generateChecked(
      ctx,
      opts.model,
      buildChunkPrompt(query, chunk.text),
      parseChunkResult,
    );
    for (const { path } of paths) {
      const entry = byPath.get(path);
      if (entry && !candidates.some((c) => c.path === entry.path))
        candidates.push(entry);
    }
  }
  return candidates;
}

/**
 * Full pipeline: stage-1 scan over TOC chunks, then stage-2 drilldown of every
 * candidate. Returns the drilldown hits (depth "drilldown"); candidates that
 * do not match are dropped. Hard-fails on first error.
 */
export async function runSearch(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
): Promise<Hit[]> {
  const entries = await loadEntries(opts);
  const candidates = await scanEntries(ctx, opts, query, entries);
  if (candidates.length === 0) return [];
  return runDrill(ctx, opts, query, candidates);
}
