import { describe, it, expect } from "vitest";
import { chunkBudgetBytes, REFERENCE_AVAILABLE_CONTEXT } from "./budget.js";

describe("chunkBudgetBytes", () => {
  it("yields ~200KB for the validated 256K-token configuration", () => {
    const bytes = chunkBudgetBytes(REFERENCE_AVAILABLE_CONTEXT);
    expect(bytes).toBeGreaterThan(180_000);
    expect(bytes).toBeLessThan(220_000);
  });

  it("scales linearly with available context", () => {
    const small = chunkBudgetBytes(65_536);
    const large = chunkBudgetBytes(REFERENCE_AVAILABLE_CONTEXT);
    // floor() on each side adds a few bytes of drift.
    expect(Math.abs(large - small * 4)).toBeLessThanOrEqual(4);
  });

  it("is always a positive integer", () => {
    for (const tokens of [1_000, 8_192, 1_048_576]) {
      const bytes = chunkBudgetBytes(tokens);
      expect(Number.isInteger(bytes)).toBe(true);
      expect(bytes).toBeGreaterThan(0);
    }
  });
});
