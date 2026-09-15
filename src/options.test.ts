import { describe, it, expect } from "vitest";
import { validateOptions, OptionsError } from "./options.js";

const VALID = {
  tocPath: "/data/TOC.yaml",
  baseDir: "/data",
  availableContext: 262_144,
  model: { providerID: "test", id: "test-model" },
};

describe("validateOptions", () => {
  it("accepts a complete option set", () => {
    expect(validateOptions(VALID)).toEqual(VALID);
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
});
