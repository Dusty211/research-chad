import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  it("rejects a negative or non-integer interval", () => {
    expect(() => new RateLimiter(-1)).toThrow(RangeError);
    expect(() => new RateLimiter(0.5)).toThrow(RangeError);
  });

  it("releases the first caller immediately", async () => {
    const limiter = new RateLimiter(50);
    const start = performance.now();
    await limiter.acquire();
    expect(performance.now() - start).toBeLessThan(40);
  });

  it("spaces sequential acquires by at least the interval", async () => {
    const limiter = new RateLimiter(60);
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      await limiter.acquire();
      times.push(performance.now());
    }
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(50);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(50);
  });

  it("spaces concurrent acquirers FIFO, one slot apart, with no bursts", async () => {
    // The regression this class exists for: N callers racing for the valve
    // must serialize onto distinct slots, never release two at once.
    const limiter = new RateLimiter(50);
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: 4 }, () =>
        limiter.acquire().then(() => times.push(performance.now())),
      ),
    );

    // FIFO release order: the i-th slot lands near t + i*interval. Tolerance
    // absorbs timer slack without accepting a burst (a burst would put two
    // releases within ~10ms of each other).
    const start = times[0];
    for (let i = 0; i < times.length; i++) {
      expect(times[i] - start).toBeGreaterThanOrEqual(i * 50 - 20);
      expect(times[i] - start).toBeLessThan(i * 50 + 40);
    }
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(30);
    }
  });

  it("keeps callers in acquisition order even when they start out of order", async () => {
    const limiter = new RateLimiter(40);
    const releaseOrder: number[] = [];
    // Call B acquires first but does its work; A acquires second. B must
    // still be released first — the valve is FIFO on acquisition, not on
    // completion of surrounding work.
    const b = limiter.acquire().then(() => releaseOrder.push(1));
    await new Promise((r) => setTimeout(r, 5));
    const a = limiter.acquire().then(() => releaseOrder.push(2));
    await Promise.all([a, b]);
    expect(releaseOrder).toEqual([1, 2]);
  });

  it("resumes pacing from the last release after an idle gap", async () => {
    // No burst just because nobody was waiting for a while: the next slot is
    // max(now, lastRelease + interval), and now wins after a long idle.
    const limiter = new RateLimiter(30);
    await limiter.acquire();
    await new Promise((r) => setTimeout(r, 100));
    const start = performance.now();
    await limiter.acquire();
    expect(performance.now() - start).toBeLessThan(90); // did not wait 2*interval
  });

  it("resolves immediately for every caller at interval 0", async () => {
    const limiter = new RateLimiter(0);
    const start = performance.now();
    await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
    expect(performance.now() - start).toBeLessThan(40);
  });
});
