/** Per-item outcome: success value or the error that item threw. */
export type Outcome<R> = { ok: true; value: R } | { ok: false; error: unknown };

/** Pool configuration for bounded-concurrency dispatch. */
export interface PoolOptions {
  /** Max items in-flight simultaneously. Must be >= 1. */
  concurrency: number;
  /** Minimum ms between dispatching new items into free slots. 0 = no throttle. */
  rateLimitMs: number;
}

/**
 * Map over items with bounded concurrency and a dispatch rate limit.
 *
 * Always resolves — item failures are captured per-item, never thrown.
 * Returns one slot per input item, in input order: position N holds the
 * outcome for item N, or `undefined` if the item was never dispatched.
 *
 * Dispatch stops on the first observed failure; all in-flight items settle
 * before the result is returned. With concurrency 1 and rateLimitMs 0 this
 * is equivalent to a sequential for-loop that halts at the first throw.
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
  let lastDispatch = 0;

  async function worker(): Promise<void> {
    while (!failed && next < items.length) {
      const i = next++;
      if (opts.rateLimitMs > 0) {
        const wait = lastDispatch + opts.rateLimitMs - Date.now();
        if (wait > 0) await sleep(wait);
      }
      lastDispatch = Date.now();

      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
        failed = true;
      }
    }
  }

  const n = Math.min(opts.concurrency, items.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/** Extract failed items with their input indices, in input order. */
export function toFailures<R>(
  outcomes: (Outcome<R> | undefined)[],
): { index: number; error: unknown }[] {
  const failures: { index: number; error: unknown }[] = [];
  outcomes.forEach((o, i) => {
    if (o && !o.ok) failures.push({ index: i, error: o.error });
  });
  return failures;
}

/** Count of items that were dispatched (have an outcome). */
export function attemptedCount<R>(
  outcomes: (Outcome<R> | undefined)[],
): number {
  return outcomes.filter((o) => o !== undefined).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
