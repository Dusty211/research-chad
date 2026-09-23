import type { Clock } from "../pipeline/rate-limiter.js";

/** Shared manual clock for deterministic tests composing real RateLimiters. */
export function makeManualClock(start = 0) {
  let time = start;
  // Pending sleeps as [targetTime, resolve], kept in reservation order.
  const pending: { target: number; resolve: () => void }[] = [];
  // Release times recorded at the moment each sleep resolves (deterministic).
  const releases: number[] = [];

  const clock: Clock = {
    now: () => time,
    sleep(ms) {
      return new Promise<void>((resolve) => {
        pending.push({ target: time + ms, resolve });
      });
    },
  };

  /** Advance the clock by `ms`, resolving due sleeps as time crosses them. */
  function advance(ms: number): void {
    const end = time + ms;
    for (;;) {
      // Find the earliest pending sleep that is now due.
      let dueIndex = -1;
      let dueTarget = Infinity;
      for (let i = 0; i < pending.length; i++) {
        if (pending[i].target <= end && pending[i].target < dueTarget) {
          dueTarget = pending[i].target;
          dueIndex = i;
        }
      }
      if (dueIndex === -1) break;
      time = dueTarget;
      const [slot] = pending.splice(dueIndex, 1);
      releases.push(time); // record at the exact release instant
      slot.resolve();
    }
    time = end;
  }

  return { clock, advance, releases };
}
