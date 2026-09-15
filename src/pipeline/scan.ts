import { readFile } from "node:fs/promises";
import { chunkBudgetBytes } from "../lib/budget.js";
import { packEntries } from "../lib/chunk.js";
import { parseToc } from "../lib/toc.js";
import { buildChunkPrompt } from "../lib/prompt.js";
import { parseChunkResult } from "../lib/validate.js";
import type { ChadOptions } from "../options.js";
import type { Hit } from "../types.js";
import { generateChecked, type GenerateCtx } from "./model.js";

/**
 * Stage 1: parse the TOC, pack entries into budget-sized chunks, and run one
 * model call per chunk. Returns hits at depth "toc". Hard-fails on first error.
 */
export async function runScan(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
): Promise<Hit[]> {
  const yamlText = await readFile(opts.tocPath, "utf8");
  const toc = parseToc(yamlText, opts.baseDir);
  if (!toc.ok) throw toc.error;

  const maxBytes = chunkBudgetBytes(opts.availableContext);
  const packed = packEntries(toc.value.entries, maxBytes);
  if (!packed.ok) throw packed.error;

  const byPath = new Map(toc.value.entries.map((e) => [e.path, e]));
  const hits: Hit[] = [];

  for (const chunk of packed.value) {
    const chunkHits = await generateChecked(
      ctx,
      opts.model,
      buildChunkPrompt(query, chunk.text),
      parseChunkResult,
    );

    for (const { path, matchReason } of chunkHits) {
      const entry = byPath.get(path);
      if (!entry) continue; // model echoed a path not in this chunk; ignore
      hits.push({
        dir: entry.dir,
        path: entry.path,
        name: entry.name,
        kind: entry.kind,
        depth: "toc",
        matchReason,
      });
    }
  }

  return hits;
}
