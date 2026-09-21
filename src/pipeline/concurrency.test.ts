import { describe, it, expect } from "vitest";
import {
  attemptedCount,
  mapWithConcurrency,
  toFailures,
} from "./concurrency.js";

const POOL = { concurrency: 1, rateLimitMs: 0 };

describe("mapWithConcurrency", () => {
  it("returns an empty array for empty input", async () => {
    const result = await mapWithConcurrency([], POOL, async (n) => n * 2);
    expect(result).toEqual([]);
  });

  it("processes items sequentially in order at concurrency 1", async () => {
    const order: number[] = [];
    const result = await mapWithConcurrency([1, 2, 3], POOL, async (n) => {
      order.push(n);
      return n * 2;
    });
    expect(order).toEqual([1, 2, 3]);
    expect(result).toEqual([
      { ok: true, value: 2 },
      { ok: true, value: 4 },
      { ok: true, value: 6 },
    ]);
  });

  it("passes the correct index to fn", async () => {
    const indices: number[] = [];
    await mapWithConcurrency(["a", "b", "c"], POOL, async (_, i) => {
      indices.push(i);
      return i;
    });
    expect(indices).toEqual([0, 1, 2]);
  });

  it("captures a rejection at the correct index and stops dispatching", async () => {
    const attempted: number[] = [];
    const result = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      POOL,
      async (n) => {
        attempted.push(n);
        if (n === 3) throw new Error("boom");
        return n;
      },
    );

    // Items after the failure were never dispatched.
    expect(attempted).toEqual([1, 2, 3]);
    expect(result).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
      { ok: false, error: expect.any(Error) },
      undefined,
      undefined,
    ]);
    const failure = result[2] as { ok: false; error: unknown };
    expect(failure.error).toBeInstanceOf(Error);
    expect((failure.error as Error).message).toBe("boom");
  });

  it("dispatches up to concurrency items in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      { concurrency: 3, rateLimitMs: 0 },
      async (n) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return n;
      },
    );

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually ran in parallel
    expect(result.every((o) => o?.ok)).toBe(true);
  });

  it("keeps results in input order regardless of completion order", async () => {
    const result = await mapWithConcurrency(
      [1, 2, 3],
      { concurrency: 3, rateLimitMs: 0 },
      async (n) => {
        // Item 1 is slowest; item 3 is fastest.
        await new Promise((r) => setTimeout(r, (4 - n) * 10));
        return n * 10;
      },
    );

    expect(result).toEqual([
      { ok: true, value: 10 },
      { ok: true, value: 20 },
      { ok: true, value: 30 },
    ]);
  });

  it("waits for all in-flight items to settle before returning on failure", async () => {
    let slowSettled = false;
    const result = await mapWithConcurrency(
      [1, 2],
      { concurrency: 2, rateLimitMs: 0 },
      async (n) => {
        if (n === 1) throw new Error("fast fail");
        // Item 2 is slow; must still settle before the pool resolves.
        await new Promise((r) => setTimeout(r, 30));
        slowSettled = true;
        return n;
      },
    );

    expect(slowSettled).toBe(true);
    expect(result[0]).toEqual({ ok: false, error: expect.any(Error) });
    expect(result[1]).toEqual({ ok: true, value: 2 });
  });

  it("captures multiple failures when they are all in-flight", async () => {
    // All four dispatch immediately (concurrency 4); two fail while the others
    // are still in-flight, so both failures must be captured before settling.
    const result = await mapWithConcurrency(
      [1, 2, 3, 4],
      { concurrency: 4, rateLimitMs: 0 },
      async (n) => {
        if (n === 2 || n === 4) throw new Error(`fail ${n}`);
        await new Promise((r) => setTimeout(r, 10));
        return n;
      },
    );

    expect(result[0]).toEqual({ ok: true, value: 1 });
    expect(result[1]).toMatchObject({ ok: false });
    expect(result[2]).toEqual({ ok: true, value: 3 });
    expect(result[3]).toMatchObject({ ok: false });
  });

  it("honors rateLimitMs between dispatches", async () => {
    const dispatchTimes: number[] = [];
    await mapWithConcurrency(
      [1, 2, 3],
      { concurrency: 1, rateLimitMs: 50 },
      async (n) => {
        dispatchTimes.push(Date.now());
        return n;
      },
    );

    expect(dispatchTimes).toHaveLength(3);
    const gap1 = dispatchTimes[1] - dispatchTimes[0];
    const gap2 = dispatchTimes[2] - dispatchTimes[1];
    expect(gap1).toBeGreaterThanOrEqual(40); // allow timer slack
    expect(gap2).toBeGreaterThanOrEqual(40);
  });

  it("does not over-spawn workers when concurrency exceeds item count", async () => {
    let started = 0;
    await mapWithConcurrency(
      [1, 2],
      { concurrency: 10, rateLimitMs: 0 },
      async (n) => {
        started++;
        return n;
      },
    );
    expect(started).toBe(2);
  });

  it("treats non-Error throws as captured errors", async () => {
    const result = await mapWithConcurrency([1], POOL, async () => {
      throw "string failure";
    });
    expect(result[0]).toEqual({ ok: false, error: "string failure" });
  });

  it("stops dispatching at concurrency > 1 and leaves later items undefined", async () => {
    // Concurrency 2: items 1 and 2 dispatch together; item 1 fails fast while
    // item 2 is still in-flight. Item 3 must never be dispatched.
    const attempted: number[] = [];
    const result = await mapWithConcurrency(
      [1, 2, 3],
      { concurrency: 2, rateLimitMs: 0 },
      async (n) => {
        attempted.push(n);
        if (n === 1) throw new Error("fast fail");
        await new Promise((r) => setTimeout(r, 20));
        return n;
      },
    );

    expect(attempted).toEqual([1, 2]);
    expect(result[0]).toMatchObject({ ok: false });
    expect(result[1]).toEqual({ ok: true, value: 2 });
    expect(result[2]).toBeUndefined();
  });

  it("paces refills by rateLimitMs at concurrency > 1", async () => {
    // The initial burst fills all slots immediately (no prior dispatch to
    // throttle against); the rate limit paces *subsequent* dispatches. With
    // 4 items, 2 workers, ~5ms work and a 60ms throttle, dispatches must
    // span well beyond what an unthrottled pool would take (~10ms).
    const dispatchTimes: number[] = [];
    const start = Date.now();
    await mapWithConcurrency(
      [1, 2, 3, 4],
      { concurrency: 2, rateLimitMs: 60 },
      async (n) => {
        dispatchTimes.push(Date.now());
        await new Promise((r) => setTimeout(r, 5));
        return n;
      },
    );
    const span = Date.now() - start;

    expect(dispatchTimes).toHaveLength(4);
    // Unthrottled: two waves of ~5ms ≈ 10-20ms total. Throttled refills add
    // >= 60ms each, so the run must clearly exceed the unthrottled bound.
    expect(span).toBeGreaterThan(70);
  });
});

describe("toFailures", () => {
  it("returns [] when nothing failed and skips undispatched items", () => {
    const outcomes = [
      { ok: true as const, value: 1 },
      undefined,
      { ok: true as const, value: 3 },
    ];
    expect(toFailures(outcomes)).toEqual([]);
  });

  it("collects failures with their input indices in input order", () => {
    const outcomes = [
      { ok: true as const, value: 1 },
      { ok: false as const, error: new Error("b") },
      undefined,
      { ok: false as const, error: "d" },
    ];
    expect(toFailures(outcomes)).toEqual([
      { index: 1, error: expect.any(Error) },
      { index: 3, error: "d" },
    ]);
  });
});

describe("attemptedCount", () => {
  it("counts only dispatched (non-undefined) slots", () => {
    const outcomes = [
      { ok: true as const, value: 1 },
      { ok: false as const, error: "x" },
      undefined,
      undefined,
    ];
    expect(attemptedCount(outcomes)).toBe(2);
  });

  it("returns 0 for an empty batch", () => {
    expect(attemptedCount([])).toBe(0);
  });
});
