import { describe, it, expect } from "vitest";
import {
  buildChunkPrompt,
  buildDrillFoldPrompt,
  buildDrillPartPrompt,
  buildDrillPrompt,
} from "./prompt.js";

describe("buildChunkPrompt", () => {
  it("is explicit: names the content, the query, and the exact output contract", () => {
    const prompt = buildChunkPrompt(
      "garden soil",
      "=== DOC: /x/a.md ===\n- bullets\n",
    );
    expect(prompt).toContain("Query: garden soil");
    expect(prompt).toContain("=== DOC: /x/a.md ===");
    expect(prompt).toMatch(/JSON array of the relevant entries/);
    expect(prompt).toMatch(/\{"path":/);
    expect(prompt).toMatch(/exactly 3 sentences/);
    expect(prompt).toMatch(/Return \[\] if none are relevant/);
  });

  it("includes the untrusted-data hard rule", () => {
    expect(buildChunkPrompt("q", "text")).toMatch(/untrusted data/i);
  });
});

describe("buildDrillPrompt", () => {
  it("inlines the whole document and prescribes the exact JSON object", () => {
    const prompt = buildDrillPrompt("query here", "DOC BODY");
    expect(prompt).toContain("Read this document:\nDOC BODY");
    expect(prompt).toContain("Query: query here");
    expect(prompt).toMatch(/\{"match": true\|false/);
    expect(prompt).toMatch(/exactly 3 sentences/);
  });
});

describe("buildDrillPartPrompt", () => {
  it("numbers the part and carries the running distill when present", () => {
    const first = buildDrillPartPrompt(
      "q",
      { index: 0, total: 3, text: "P1", byteLength: 2 },
      null,
    );
    expect(first).toContain("Read part 1 of 3");
    expect(first).not.toContain("So far found");

    const second = buildDrillPartPrompt(
      "q",
      { index: 1, total: 3, text: "P2", byteLength: 2 },
      "earlier evidence",
    );
    expect(second).toContain("Read part 2 of 3");
    expect(second).toContain("So far found in earlier parts: earlier evidence");
  });

  it("prescribes the part-level JSON object", () => {
    const prompt = buildDrillPartPrompt(
      "q",
      { index: 0, total: 1, text: "P", byteLength: 1 },
      null,
    );
    expect(prompt).toMatch(/\{"relevant": true\|false/);
  });
});

describe("buildDrillFoldPrompt", () => {
  it("lists accumulated evidence and reuses the standard answer contract", () => {
    const prompt = buildDrillFoldPrompt("q", ["e1", "e2"]);
    expect(prompt).toContain("- e1");
    expect(prompt).toContain("- e2");
    expect(prompt).toMatch(/\{"match": true\|false/);
  });

  it("handles no evidence collected", () => {
    const prompt = buildDrillFoldPrompt("q", []);
    expect(prompt).toContain("Query: q");
  });
});
