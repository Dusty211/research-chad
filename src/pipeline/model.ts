import type { AppError } from "../errors.js";
import type { ModelRef } from "../options.js";

/** Minimal slice of the plugin context the pipeline needs. */
export interface GenerateCtx {
  generate: {
    text(input: { model: ModelRef; prompt: string }): Promise<{ text: string }>;
  };
}

/**
 * Single-shot model generation with one identical-prompt re-roll on any
 * model-output failure (invalid JSON, schema violation, or shape-floor miss).
 * The model is non-deterministic, so all three failure classes can occur
 * randomly and a re-roll with the same prompt can succeed. A second identical
 * failure is terminal. No timeout: legitimate inferences for this workload can
 * run 20–30 min and the generate API exposes no cancellation — a wedged
 * provider will hang the tool indefinitely; there is no per-call deadline
 * because the plugin cannot distinguish slow from dead without cancellation.
 * No transport retry: OpenCode retries provider failures server-side (with
 * backoff and a hard attempt cap); a rejection here is terminal, so re-issuing
 * only adds cost.
 */
export async function generateChecked<T>(
  ctx: GenerateCtx,
  model: ModelRef,
  prompt: string,
  check: (
    raw: string,
  ) => { ok: true; value: T } | { ok: false; error: AppError },
): Promise<T> {
  const run = async () => {
    const { text } = await ctx.generate.text({ model, prompt });
    return check(text);
  };

  const first = await run();
  if (first.ok) return first.value;
  // Identical prompt, exactly one retry. Second failure is a hard fail.
  const second = await run();
  if (!second.ok) throw second.error;
  return second.value;
}
