import { describe, it, expect } from "vitest";
import { validateOptions, OptionsError } from "./options.js";

const VALID = {
  tocPath: "/data/TOC.yaml",
  baseDir: "/data",
  availableContext: 262_144,
  model: { providerID: "test", id: "test-model" },
};

describe("validateOptions", () => {
  it("accepts a complete option set and applies concurrency defaults", () => {
    expect(validateOptions(VALID)).toEqual({
      ...VALID,
      inferenceConcurrency: 1,
      inferenceRateLimitMs: 0,
    });
  });

  it("rejects non-object options", () => {
    expect(() => validateOptions(null)).toThrow(OptionsError);
    expect(() => validateOptions("nope")).toThrow(/must be an object/);
  });

  it("requires tocPath", () => {
    expect(() => validateOptions({ ...VALID, tocPath: "" })).toThrow(/tocPath/);
    expect(() => validateOptions({ ...VALID, tocPath: undefined })).toThrow(
      /tocPath/,
    );
  });

  it("requires baseDir", () => {
    expect(() => validateOptions({ ...VALID, baseDir: 42 })).toThrow(/baseDir/);
  });

  it("requires a positive integer availableContext", () => {
    expect(() => validateOptions({ ...VALID, availableContext: 0 })).toThrow(
      /availableContext/,
    );
    expect(() => validateOptions({ ...VALID, availableContext: 1.5 })).toThrow(
      /availableContext/,
    );
    expect(() =>
      validateOptions({ ...VALID, availableContext: "big" }),
    ).toThrow(/availableContext/);
  });

  it("requires a well-formed model ref", () => {
    expect(() => validateOptions({ ...VALID, model: {} })).toThrow(/model/);
    expect(() =>
      validateOptions({ ...VALID, model: { providerID: "p" } }),
    ).toThrow(/model/);
    expect(() => validateOptions({ ...VALID, model: null })).toThrow(/model/);
  });

  it("accepts explicit inferenceConcurrency and inferenceRateLimitMs", () => {
    const opts = validateOptions({
      ...VALID,
      inferenceConcurrency: 4,
      inferenceRateLimitMs: 250,
    });
    expect(opts.inferenceConcurrency).toBe(4);
    expect(opts.inferenceRateLimitMs).toBe(250);
  });

  it("rejects a non-positive-integer inferenceConcurrency", () => {
    for (const bad of [0, -1, 1.5, "3", null]) {
      expect(() =>
        validateOptions({ ...VALID, inferenceConcurrency: bad }),
      ).toThrow(/inferenceConcurrency/);
    }
  });

  it("rejects a negative or non-integer inferenceRateLimitMs", () => {
    for (const bad of [-1, 0.5, "fast", null]) {
      expect(() =>
        validateOptions({ ...VALID, inferenceRateLimitMs: bad }),
      ).toThrow(/inferenceRateLimitMs/);
    }
  });

  it("accepts inferenceRateLimitMs of 0 (no throttle)", () => {
    const opts = validateOptions({ ...VALID, inferenceRateLimitMs: 0 });
    expect(opts.inferenceRateLimitMs).toBe(0);
  });
});
