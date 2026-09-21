import { PipelineError } from "../errors.js";

/**
 * Per-item outcome: success value or the error that item threw. The failure
 * side is `Error` (not AppError) because a pooled item can reject with any
 * Error — raw fs errors included — so this stays distinct from Result<T>,
 * whose failure side is the project's expected-condition contract. Non-Error
 * rejections are normalized to an Error at the capture boundary (toError), so
 * no foreign value content ever reaches a rendered message.
 */
export type Outcome<R> = { ok: true; value: R } | { ok: false; error: Error };

/**
 * Normalize a caught rejection to an Error. AppErrors and other Errors pass
 * through with their curated messages intact; any foreign value (string,
 * number, function, object) is replaced by our own fixed description — only
 * its type is recorded, never its content, so hostile or buggy throws cannot
 * echo themselves into tool output / agent context.
 */
function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(`item rejected with a non-Error value (${typeof error})`);
}

/** Pool configuration for bounded-concurrency dispatch. */
export interface PoolOptions {
  /** Max items in-flight simultaneously. Must be >= 1. */
  concurrency: number;
}

/**
 * Map over items with bounded concurrency.
 *
 * Always resolves — item failures are captured per-item, never thrown.
 * Returns one slot per input item, in input order: position N holds the
 * outcome for item N, or `undefined` if the item was never dispatched.
 *
 * Dispatch stops on the first observed failure — new items are not sent once
 * one has failed, because under the all-or-nothing policy the run is doomed
 * and undispatched calls would only burn provider quota for nothing. All
 * in-flight items still settle before the result is returned: the generate
 * API has no cancellation, so an aborted wait would abandon a call that
 * keeps running server-side. Items never dispatched are `undefined` holes
 * (not sentinel failures) so callers can distinguish "ran and failed" from
 * "never ran" when reporting attempted vs total. With concurrency 1 this is
 * equivalent to a sequential for-loop that halts at the first throw.
 *
 * The pool has no notion of timing: rate limiting is a separate RateLimiter
 * composed around fn by the caller, so every individual dispatch — including
 * the first wave — passes through the valve.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  opts: PoolOptions,
  fn: (item: T, index: number) => Promise<R>,
): Promise<(Outcome<R> | undefined)[]> {
  const results: (Outcome<R> | undefined)[] = new Array(items.length);
  if (items.length === 0) return results;

  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error: toError(error) };
        failed = true;
      }
    }
  }

  const n = Math.min(opts.concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * All-or-nothing settlement of a pool run: if any item failed, throw a
 * PipelineError listing every failure plus the attempted/total counts;
 * otherwise return the success values in input order. This is the single home
 * of the v1 failure policy — pipeline stages must not re-derive it.
 */
export function settleAllOrNothing<R>(
  outcomes: (Outcome<R> | undefined)[],
  total: number,
): R[] {
  const failures = outcomes.flatMap((o, i) =>
    o && !o.ok ? [{ index: i, error: o.error }] : [],
  );
  if (failures.length > 0) {
    const attempted = outcomes.filter((o) => o !== undefined).length;
    throw new PipelineError(failures, total, attempted);
  }
  const values: R[] = [];
  for (const o of outcomes) {
    if (o === undefined || !o.ok) continue; // no failure survives the check above
    values.push(o.value);
  }
  return values;
}
