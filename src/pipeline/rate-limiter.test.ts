import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rate-limiter.js";
import { makeManualClock } from "../testutil/clock.js";

describe("RateLimiter", () => {
  it("rejects a negative or non-integer interval", () => {
    expect(() => new RateLimiter(-1)).toThrow(RangeError);
    expect(() => new RateLimiter(0.5)).toThrow(RangeError);
  });

  it("releases the first caller immediately (no prior slot to wait for)", async () => {
    const { clock, advance } = makeManualClock();
    const limiter = new RateLimiter(50, clock);
    // No sleep is even scheduled: the first slot is at t=now.
    await limiter.acquire();
    expect(clock.now()).toBe(0);
    advance(1000); // nothing pending; time just moves
    expect(clock.now()).toBe(1000);
  });

  it("spaces sequential acquires by exactly the interval", async () => {
    const { clock, advance } = makeManualClock();
    const limiter = new RateLimiter(60, clock);
    const times: number[] = [];

    // Fire each acquire, then advance the clock to release it, in turn. The
    // first is immediate; each subsequent waits exactly one interval.
    const p1 = limiter.acquire().then(() => times.push(clock.now()));
    await p1; // t=0, no wait
    const p2 = limiter.acquire().then(() => times.push(clock.now()));
    advance(60); // release the slot reserved at t=60
    await p2;
    const p3 = limiter.acquire().then(() => times.push(clock.now()));
    advance(60); // release the slot reserved at t=120
    await p3;

    expect(times).toEqual([0, 60, 120]);
    expect(times[1] - times[0]).toBe(60);
    expect(times[2] - times[1]).toBe(60);
  });

  it("spaces concurrent acquirers FIFO, one slot apart, with no bursts", async () => {
    // N callers racing for the valve must serialize onto distinct slots, never
    // release two at once. We assert on the *reserved slot times* (deterministic
    // by construction) and that each caller is released exactly when its slot
    // comes due — recorded by the clock itself at resolution, so no
    // microtask-ordering dependence.
    const { clock, advance, releases } = makeManualClock();
    const limiter = new RateLimiter(50, clock);

    // All four reserve synchronously (FIFO) before any sleep resolves:
    // slots at t=0, 50, 100, 150. The first is immediate (no sleep); the other
    // three go through the clock and are recorded at their exact due times.
    const acquires = Array.from({ length: 4 }, () => limiter.acquire());
    expect(clock.now()).toBe(0); // first slot reserved at t=0, released immediately
    advance(200); // run the clock past every scheduled slot
    await Promise.all(acquires);

    // The three slept slots released exactly one interval apart, in FIFO order.
    expect(releases).toEqual([50, 100, 150]);
  });

  it("reserves slots in acquisition order even when callers start out of order", async () => {
    // Pins slot *reservation* order: B acquires first (slot t=0), A second
    // (slot t=40). Each caller proceeds exactly when its own reserved slot
    // comes due, so B goes before A. The slept-slot FIFO release ordering is
    // covered by the concurrent-acquirers test.
    const { clock, advance } = makeManualClock();
    const limiter = new RateLimiter(40, clock);
    const releaseOrder: number[] = [];

    const b = limiter.acquire().then(() => releaseOrder.push(1));
    advance(40);
    const a = limiter.acquire().then(() => releaseOrder.push(2));
    advance(40);
    await Promise.all([a, b]);

    expect(releaseOrder).toEqual([1, 2]);
  });

  it("resumes pacing from the last release after an idle gap (no burst)", async () => {
    // After a long idle, `now` wins over lastRelease+interval — the next slot is
    // at now, not now+interval. So no artificial delay is introduced by idling.
    const { clock, advance } = makeManualClock();
    const limiter = new RateLimiter(30, clock);

    await limiter.acquire(); // slot t=0 (immediate)
    advance(100); // idle well past one interval
    const before = clock.now(); // 100
    const p = limiter.acquire().then(() => {
      // now (100) > lastRelease+interval (30), so it is immediate: no wait.
      expect(clock.now()).toBe(before);
    });
    await p;
  });

  it("resolves immediately for every caller at interval 0", async () => {
    const { clock } = makeManualClock();
    const limiter = new RateLimiter(0, clock);
    await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
    expect(clock.now()).toBe(0); // no time elapsed at all
  });
});
