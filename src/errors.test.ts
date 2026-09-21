import { describe, it, expect } from "vitest";
import { PipelineError } from "./errors.js";

describe("PipelineError", () => {
  it("renders the header with failure count, total, and attempted", () => {
    const e = new PipelineError([{ index: 0, error: new Error("boom") }], 5, 3);
    expect(e.message).toBe(
      "Pipeline failed: 1 of 5 items errored (3 attempted).\n  [1/5] boom",
    );
  });

  it("lists every failure on its own line with a 1-based position", () => {
    const e = new PipelineError(
      [
        { index: 1, error: new Error("second fails") },
        { index: 4, error: "raw string failure" },
      ],
      6,
      5,
    );
    expect(e.message).toBe(
      [
        "Pipeline failed: 2 of 6 items errored (5 attempted).",
        "  [2/6] second fails",
        "  [5/6] raw string failure",
      ].join("\n"),
    );
  });

  it("exposes the structured fields for programmatic consumers", () => {
    const failures = [{ index: 2, error: new Error("x") }];
    const e = new PipelineError(failures, 4, 3);
    expect(e.code).toBe("pipeline");
    expect(e.failures).toBe(failures);
    expect(e.total).toBe(4);
    expect(e.attempted).toBe(3);
  });
});
