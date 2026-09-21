/**
 * FIFO dispatch gate: releases one caller at a time, at least `intervalMs`
 * apart, in acquisition order. Knows nothing about what the callers do — it
 * only controls when they may proceed. Concurrency is a separate concern and
 * must be composed around this (e.g. run each pooled item through acquire()),
 * never merged into it: the valve applies to every individual dispatch.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  /** Release time of the last acquired slot, on a monotonic clock. */
  private nextReleaseAt = 0;

  constructor(intervalMs: number) {
    // An interval of 0 means "no spacing" — callers construct no limiter at
    // all in that case, so a zero-interval instance is only ever used by tests.
    if (!Number.isInteger(intervalMs) || intervalMs < 0) {
      throw new RangeError(
        `RateLimiter interval must be a non-negative integer, got ${intervalMs}`,
      );
    }
    this.intervalMs = intervalMs;
  }

  /** Resolve when it is this caller's turn. Reservations are FIFO and atomic. */
  acquire(): Promise<void> {
    // One synchronous segment: reserve the slot, then (if needed) wait for it.
    const now = performance.now();
    const releaseAt = Math.max(now, this.nextReleaseAt + this.intervalMs);
    this.nextReleaseAt = releaseAt;
    const wait = releaseAt - now;
    if (wait <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, wait));
  }
}
