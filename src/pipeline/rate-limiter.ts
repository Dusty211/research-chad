/**
 * A monotonic time source the limiter reads and sleeps against. Production uses
 * the real clock; tests inject a manual one so spacing assertions are exact and
 * deterministic (no wall-clock flakiness). The reservation math is identical in
 * both — only the source of "now" and the sleep mechanism differ.
 */
export interface Clock {
  /** Current time in ms, monotonically non-decreasing. */
  now(): number;
  /** Resolve after `ms` elapsed on this clock. */
  sleep(ms: number): Promise<void>;
}

/** The production clock: monotonic performance.now() + setTimeout. */
export const systemClock: Clock = {
  now: () => performance.now(),
  sleep(ms) {
    return new Promise<void>((resolve) => {
      // unref so a pending wait never holds the event loop open on its own.
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  },
};

/**
 * FIFO dispatch gate: releases one caller at a time, at least `intervalMs`
 * apart, in acquisition order. Knows nothing about what the callers do — it
 * only controls when they may proceed. Concurrency is a separate concern and
 * must be composed around this (e.g. run each pooled item through acquire()),
 * never merged into it: the valve applies to every individual dispatch.
 */
export class RateLimiter {
  private readonly intervalMs: number;
  private readonly clock: Clock;
  /** Release time of the last acquired slot, on the clock's time base. */
  private nextReleaseAt = 0;
  /** Whether any slot has been reserved yet — the first caller is immediate. */
  private started = false;

  constructor(intervalMs: number, clock: Clock = systemClock) {
    if (!Number.isInteger(intervalMs) || intervalMs < 0) {
      throw new RangeError(
        `RateLimiter interval must be a non-negative integer, got ${intervalMs}`,
      );
    }
    this.intervalMs = intervalMs;
    this.clock = clock;
  }

  /** Resolve when it is this caller's turn. Reservations are FIFO and atomic. */
  acquire(): Promise<void> {
    // One synchronous segment: reserve the slot, then (if needed) wait for it.
    const now = this.clock.now();
    // The first caller has no prior dispatch to space against, so it goes out
    // immediately; each subsequent one is >= interval after the last release.
    const releaseAt = this.started
      ? Math.max(now, this.nextReleaseAt + this.intervalMs)
      : now;
    this.nextReleaseAt = releaseAt;
    this.started = true;
    const wait = releaseAt - now;
    if (wait <= 0) return Promise.resolve();
    return this.clock.sleep(wait);
  }
}
