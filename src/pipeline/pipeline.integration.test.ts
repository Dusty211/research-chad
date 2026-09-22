import { describe, it, expect } from "vitest";
import {
  mapWithConcurrency,
  settleAllOrNothing,
  type Gate,
} from "./concurrency.js";
import { RateLimiter } from "./rate-limiter.js";
import { makeManualClock } from "../testutil/clock.js";

// Composition lane: the real pool with the real limiter as its gate, on a
// manual clock. Pins only what composition adds — that RateLimiter satisfies
// the gate contract in practice and that N2 (stop-at-valve) holds end-to-end.
describe("mapWithConcurrency + RateLimiter (composition)", () => {
  it("does not dispatch an item parked at the valve after a failure (N2)", async () => {
    const { clock, advance } = makeManualClock();
    const limiter = new RateLimiter(100, clock);
    const dispatched: number[] = [];

    const run = mapWithConcurrency(
      [1, 2],
      { concurrency: 2, gate: limiter },
      async (n) => {
        dispatched.push(n);
        if (n === 1) {
          await Promise.resolve(); // failure recorded before any slot release
          throw new Error("boom");
        }
        return n;
      },
    );
    // Yield for the failure to be recorded, then release item 2's parked slot.
    await Promise.resolve();
    await Promise.resolve();
    advance(100);
    const outcomes = await run;

    expect(dispatched).toEqual([1]); // item 2 never reached the model
    expect(outcomes[1]).toBeUndefined(); // hole, not a failure
    try {
      settleAllOrNothing(outcomes, 2);
      throw new Error("expected settleAllOrNothing to throw");
    } catch (e) {
      expect(e).toMatchObject({ code: "pipeline", total: 2, attempted: 1 });
    }
  });

  it("every dispatch passes through the real valve", async () => {
    const { clock, advance } = makeManualClock();
    const limiter = new RateLimiter(100, clock);
    let count = 0;
    const gate: Gate = {
      acquire: () => {
        count++;
        return limiter.acquire();
      },
    };

    const run = mapWithConcurrency(
      [1, 2, 3, 4],
      { concurrency: 2, gate },
      async (n) => n,
    );
    // Each wave reserves its slots when its items finish — after the previous
    // advance already ran — so cover each wave's reservation in turn:
    // advance, yield for the next claim+reservation, repeat.
    advance(1000);
    await Promise.resolve();
    advance(1000);
    await Promise.resolve();
    advance(1000);
    expect(await run).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 2 },
      { ok: true, value: 3 },
      { ok: true, value: 4 },
    ]);
    expect(count).toBe(4); // every dispatch went through acquire()
  });
});
