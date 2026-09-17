import type { ChadOptions } from "../options.js";
import type { Hit } from "../types.js";
import type { GenerateCtx } from "./model.js";
import { loadEntries, runStage1 } from "./stage1.js";

/**
 * Stage 1 as a tool: parse the TOC and scan it for entries relevant to the
 * query. Returns hits at depth "toc". Hard-fails on first error.
 */
export async function runScan(
  ctx: GenerateCtx,
  opts: ChadOptions,
  query: string,
): Promise<Hit[]> {
  const entries = await loadEntries(opts);
  const stage1 = await runStage1(ctx, opts, query, entries);
  return stage1.map(({ entry, matchReason }) => ({
    dir: entry.dir,
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    depth: "toc" as const,
    matchReason,
  }));
}
