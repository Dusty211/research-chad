import type { AppError } from "../errors.js";
import type { ModelRef } from "../options.js";

/** Minimal slice of the plugin context the pipeline needs. */
export interface GenerateCtx {
  generate: {
    text(input: { model: ModelRef; prompt: string }): Promise<{ text: string }>;
  };
}

/** Single-shot model generation with one identical-prompt retry on AppError from `check`. */
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
