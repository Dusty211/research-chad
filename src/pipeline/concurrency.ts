import { PipelineError, type PipelineFailure } from "../errors.js";

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

/**
 * A pacing gate the pool consults before every dispatch. The pool knows a
 * gate, not intervals or clocks — RateLimiter satisfies this structurally.
 */
export interface Gate {
  acquire(): Promise<void>;
}

/** Pool configuration for bounded-concurrency dispatch. */
export interface PoolOptions {
  /** Max items in-flight simultaneously. Must be >= 1. */
  concurrency: number;
  /** Optional gate consulted before every dispatch (e.g. a rate limiter). */
  gate?: Gate;
}

/**
 * Map over items with bounded concurrency.
 *
 * Always resolves — item failures are captured per-item, never thrown. A
 * rejecting gate rejects the pool (an infrastructure fault, not an item
 * failure). Returns one slot per input item, in input order: position N holds
 * the outcome for item N, or `undefined` if the item was never dispatched.
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
 * Pacing is a separate concern supplied as an optional gate, consulted before
 * every individual dispatch — including the first wave. The claim and the
 * gate wait happen in one synchronous segment, so no worker holds a gate slot
 * for an unclaimed item; after the gate releases, the pool re-checks its own
 * failure flag synchronously, so any failure recorded before the release is
 * seen and the item is left as an undefined hole (never dispatched). A
 * failure recorded in the same microtask window as a gate release — including
 * gates that resolve immediately — cannot be observed by the released item's
 * re-check. Inherent to the single-threaded event loop without cancellation,
 * so at most one extra pool dispatch (which may itself retry once, so at most
 * two provider calls) can escape past a failure.
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
    for (;;) {
      if (failed || next >= items.length) break; // no new claims once a failure has landed
      const i = next++;
      if (opts.gate) await opts.gate.acquire();
      if (failed) continue; // parked at the gate when a failure was recorded: hole, never dispatched
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
  const failures: PipelineFailure[] = [];
  const values: R[] = [];
  let attempted = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o === undefined) continue;
    attempted++;
    if (o.ok) values.push(o.value);
    else failures.push({ index: i, error: o.error });
  }
  if (failures.length > 0) {
    throw new PipelineError(failures, total, attempted);
  }
  return values;
}
