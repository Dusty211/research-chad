import { describe, it, expect } from "vitest";
import {
  parseChunkResult,
  parseDrillPartResult,
  parseDrillResult,
  toHit,
} from "./validate.js";

const REASON = "First sentence. Second sentence. Third sentence.";

describe("parseChunkResult", () => {
  it("accepts a JSON array of {path, matchReason}", () => {
    const result = parseChunkResult(
      JSON.stringify([
        { path: "/a/b.md", matchReason: REASON },
        { path: "/c/d.md", matchReason: REASON },
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { path: "/a/b.md", matchReason: REASON },
        { path: "/c/d.md", matchReason: REASON },
      ]);
    }
  });

  it("accepts an empty array", () => {
    const result = parseChunkResult("[]");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("rejects invalid JSON with the raw output preserved", () => {
    const result = parseChunkResult("not json [");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("model_output");
      expect((result.error as unknown as { raw: string }).raw).toBe(
        "not json [",
      );
    }
  });

  it("rejects non-array JSON", () => {
    const result = parseChunkResult('{"a": 1}');
    expect(result.ok).toBe(false);
  });

  it("rejects elements that are not {path, matchReason} objects", () => {
    expect(parseChunkResult('["/a.md"]').ok).toBe(false);
    expect(parseChunkResult('[{"path": "/a.md"}]').ok).toBe(false);
    expect(
      parseChunkResult('[{"path": "/a.md", "matchReason": "x", "extra": 1}]')
        .ok,
    ).toBe(false);
  });
});

describe("matchReason shape", () => {
  it("rejects a single-sentence matchReason", () => {
    const result = parseChunkResult(
      JSON.stringify([{ path: "/a.md", matchReason: "One lazy sentence." }]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects short degenerate output with periods", () => {
    const result = parseChunkResult(
      JSON.stringify([{ path: "/a.md", matchReason: "a. b. c." }]),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a multi-sentence matchReason", () => {
    const result = parseChunkResult(
      JSON.stringify([
        { path: "/a.md", matchReason: "First fact. Second fact. Third fact." },
      ]),
    );
    expect(result.ok).toBe(true);
  });
});

describe("parseDrillPartResult", () => {
  it("accepts relevant with evidence", () => {
    const result = parseDrillPartResult(
      '{"relevant": true, "evidence": "found it"}',
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toEqual({ relevant: true, evidence: "found it" });
  });

  it("accepts not-relevant with null evidence", () => {
    const result = parseDrillPartResult(
      '{"relevant": false, "evidence": null}',
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toEqual({ relevant: false, evidence: null });
  });

  it("rejects extra properties", () => {
    const result = parseDrillPartResult(
      '{"relevant": true, "evidence": null, "extra": 1}',
    );
    expect(result.ok).toBe(false);
  });
});

describe("parseDrillResult", () => {
  it("accepts a match with multi-sentence shape", () => {
    const reason = "First sentence. Second sentence. Third sentence.";
    const result = parseDrillResult(
      `{"match": true, "matchReason": "${reason}"}`,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a non-match with null matchReason", () => {
    const result = parseDrillResult('{"match": false, "matchReason": null}');
    expect(result.ok).toBe(true);
  });

  it("rejects a match whose matchReason lacks sentence shape", () => {
    const result = parseDrillResult(
      '{"match": true, "matchReason": "One lazy sentence."}',
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a match with null matchReason", () => {
    const result = parseDrillResult('{"match": true, "matchReason": null}');
    expect(result.ok).toBe(false);
  });
});

describe("toHit", () => {
  it("promotes a validated drilldown result to a Hit at depth drilldown", () => {
    const hit = toHit(
      { dir: "projects/p", path: "/x.md", name: "x.md", kind: "doc" },
      { match: true, matchReason: "One. Two. Three." },
    );
    expect(hit).toEqual({
      dir: "projects/p",
      path: "/x.md",
      name: "x.md",
      kind: "doc",
      depth: "drilldown",
      matchReason: "One. Two. Three.",
    });
  });
});
