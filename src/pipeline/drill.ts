import { readFile } from "node:fs/promises";
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
import { generateChecked, type GenerateCtx } from "./model.js";

/**
 * Stage 2: for each candidate entry, read its file and judge relevance.
 * The entry's path (resolved at parse time) is the identity — no lookup.
 * Files within budget get one call; larger files run the left-to-right
 * overflow fold. Returns hits at depth "drilldown". Hard-fails on first error.
 */
export async function runDrill(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  candidates: TocEntry[],
): Promise<Hit[]> {
  const maxBytes = chunkBudgetBytes(opts.availableContext);
  const hits: Hit[] = [];

  for (const entry of candidates) {
    const text = await readFile(entry.path, "utf8"); // ENOENT → hard fail naming the path

    const result =
      text.length <= maxBytes
        ? await generateChecked(
            ctx,
            opts.model,
            buildDrillPrompt(query, text),
            parseDrillResult,
          )
        : await drillOverflow(ctx, opts, query, text, maxBytes);

    if (result.match) hits.push(toHit(entry, result));
  }

  return hits;
}

/** Left-to-right reduce over parts, threading the running distill forward. */
async function drillOverflow(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
  text: string,
  maxBytes: number,
) {
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
