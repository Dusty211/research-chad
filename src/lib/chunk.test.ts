import { describe, it, expect } from "vitest";
import {
  byteLength,
  packEntries,
  renderEntryBlock,
  sliceFile,
} from "./chunk.js";
import type { TocEntry } from "../types.js";

function entry(name: string, bullets: string[]): TocEntry {
  return {
    kind: "doc",
    name,
    path: `/base/projects/p/docs/${name}`,
    dir: "projects/p",
    summary: bullets,
  };
}

describe("renderEntryBlock", () => {
  it("renders a header line and one bullet per line", () => {
    const block = renderEntryBlock(entry("a.md", ["one", "two"]));
    expect(block).toBe(
      "=== DOC: /base/projects/p/docs/a.md ===\n- one\n- two\n\n",
    );
  });
});

describe("packEntries", () => {
  it("fits all entries in one chunk when under budget", () => {
    const packed = packEntries([entry("a.md", ["x"])], 10_000);
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    expect(packed.value).toHaveLength(1);
    expect(packed.value[0].total).toBe(1);
    expect(packed.value[0].paths).toEqual(["/base/projects/p/docs/a.md"]);
  });

  it("splits into multiple chunks at the byte budget, preserving order", () => {
    // Each block is ~60 bytes; a 150-byte budget holds exactly two.
    const entries = [0, 1, 2, 3].map((i) =>
      entry(`a${i}.md`, ["filler filler filler"]),
    );
    const packed = packEntries(entries, 150);
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;

    expect(packed.value.length).toBeGreaterThan(1);
    for (const chunk of packed.value) {
      expect(chunk.byteLength).toBeLessThanOrEqual(150);
      expect(chunk.total).toBe(packed.value.length);
    }
    // Order preserved across chunks.
    const allPaths = packed.value.flatMap((c) => c.paths);
    expect(allPaths).toEqual(entries.map((e) => e.path));
  });

  it("never splits an entry across chunks", () => {
    // Big block ~150 bytes; budget 200 fits it plus one small (~40-byte) block.
    const big = entry("big.md", ["z".repeat(120)]);
    const small = entry("small.md", ["y"]);
    const packed = packEntries([small, big, small], 200);
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    for (const chunk of packed.value) {
      // A chunk containing the big entry contains nothing else.
      if (chunk.paths.some((p) => p.endsWith("big.md"))) {
        expect(chunk.paths).toHaveLength(1);
      }
    }
  });

  it("fails when a single entry exceeds the budget", () => {
    const packed = packEntries([entry("huge.md", ["z".repeat(500)])], 100);
    expect(packed.ok).toBe(false);
    if (packed.ok) return;
    expect(packed.error.code).toBe("chunk_budget");
  });

  it("reports exact byte lengths", () => {
    const packed = packEntries([entry("a.md", ["abc"])], 10_000);
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    expect(packed.value[0].byteLength).toBe(byteLength(packed.value[0].text));
  });

  it("joins entry blocks verbatim into chunk text", () => {
    const entries = [entry("a.md", ["one"]), entry("b.md", ["two"])];
    const packed = packEntries(entries, 10_000);
    expect(packed.ok).toBe(true);
    if (!packed.ok) return;
    // The chunk text is the exact concatenation of its entries' rendered
    // blocks — no separators, no truncation.
    expect(packed.value[0].text).toBe(
      renderEntryBlock(entries[0]) + renderEntryBlock(entries[1]),
    );
  });
});

describe("sliceFile", () => {
  it("returns a single part for small content", () => {
    const sliced = sliceFile("a\nb\nc", 10_000);
    expect(sliced.ok).toBe(true);
    if (!sliced.ok) return;
    expect(sliced.value).toHaveLength(1);
    expect(sliced.value[0].text).toBe("a\nb\nc");
  });

  it("breaks only on line boundaries", () => {
    const text = [
      "l1".padEnd(20, "x"),
      "l2".padEnd(20, "y"),
      "l3".padEnd(20, "z"),
    ].join("\n");
    // Budget fits exactly one 20-byte line plus the newline.
    const sliced = sliceFile(text, 21);
    expect(sliced.ok).toBe(true);
    if (!sliced.ok) return;

    expect(sliced.value.length).toBe(3);
    for (const part of sliced.value) {
      expect(part.text).not.toContain("\n");
      expect(part.byteLength).toBeLessThanOrEqual(21);
    }
    // Reassembling parts with newlines restores the original.
    expect(sliced.value.map((p) => p.text).join("\n")).toBe(text);
  });

  it("keeps a long final line without trailing newline intact", () => {
    const text = "short\n" + "tail".repeat(50); // no trailing newline
    const sliced = sliceFile(text, 10_000);
    expect(sliced.ok).toBe(true);
    if (!sliced.ok) return;
    expect(sliced.value.at(-1)!.text.endsWith("tail")).toBe(true);
  });

  it("fails on empty content", () => {
    const sliced = sliceFile("", 100);
    expect(sliced.ok).toBe(false);
    if (sliced.ok) return;
    expect(sliced.error.code).toBe("chunk_budget");
  });

  it("fails when a single line exceeds the part budget", () => {
    const sliced = sliceFile("a\n" + "x".repeat(50), 10);
    expect(sliced.ok).toBe(false);
    if (sliced.ok) return;
    expect(sliced.error.code).toBe("chunk_budget");
    expect(sliced.error.message).toContain("exceeding the 10-byte part budget");
  });

  it("preserves a trailing newline across multi-part slices", () => {
    // The source ends with "\n"; split() turns that into a final "" element.
    // Slicing into >=2 parts must still let join("\n") reproduce the original
    // exactly — no dropped or duplicated newlines at the part boundaries.
    const text = "a\nb\nc\n";
    // Budget of 4 bytes: "a\nb" is 3, adding "c" would exceed, so it splits.
    const sliced = sliceFile(text, 4);
    expect(sliced.ok).toBe(true);
    if (!sliced.ok) return;

    expect(sliced.value.length).toBeGreaterThan(1);
    // Raw concatenation with the joining newline equals the source verbatim.
    expect(sliced.value.map((p) => p.text).join("\n")).toBe(text);
    // The trailing newline lands on the last part (as a zero-length final line).
    expect(sliced.value.at(-1)!.text.endsWith("\n")).toBe(true);
  });
});
