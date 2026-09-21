import type { ChadOptions } from "../options.js";
import type { Hit } from "../types.js";
import type { GenerateCtx } from "./model.js";
import { runDrill } from "./drill.js";
import { loadEntries, runStage1 } from "./stage1.js";

/**
 * Full pipeline: stage-1 scan over TOC chunks, then stage-2 drilldown of every
 * candidate. Returns the drilldown hits (depth "drilldown"); candidates that
 * do not match are dropped. All-or-nothing at each stage: any failure raises a
 * PipelineError listing every failed item.
 */
export async function runSearch(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
): Promise<Hit[]> {
  const entries = await loadEntries(opts);
  // runStage1 already dedupes by entry path, so each candidate is drilled once.
  const candidates = (await runStage1(ctx, opts, query, entries)).map(
    ({ entry }) => entry,
  );
  if (candidates.length === 0) return [];
  return runDrill(ctx, opts, query, candidates);
}
