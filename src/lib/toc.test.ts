import { describe, it, expect } from "vitest";
import { parseToc, resolveEntryPath } from "./toc.js";

const BASE = "/data/exfil";

const VALID_YAML = `
projects:
  - name: "alpha"
    dir: projects/alpha
    docs:
      - name: "workflow.md"
        summary:
          - "A workflow doc"
          - "Second bullet"
      - name: "no-summary.json"
    conversations:
      - name: "5fe81611_notes.md"
        uuid: 5fe81611
        created_at: 2025-01-15T10:30:00Z
        summary:
          - "Notes on a workbench project"
`;

describe("parseToc", () => {
  it("parses docs and conversations into ordered entries with resolved paths", () => {
    const result = parseToc(VALID_YAML, BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [doc, noSummary, convo] = result.value.entries;
    expect(result.value.entries).toHaveLength(3);

    expect(doc).toEqual({
      kind: "doc",
      name: "workflow.md",
      path: `${BASE}/projects/alpha/docs/workflow.md`,
      dir: "projects/alpha",
      summary: ["A workflow doc", "Second bullet"],
    });

    expect(noSummary.summary).toEqual([]);

    // The filename is the identity — verbatim, uuid prefix and all.
    expect(convo.kind).toBe("conversation");
    expect(convo.name).toBe("5fe81611_notes.md");
    expect(convo.path).toBe(
      `${BASE}/projects/alpha/summaries/5fe81611_notes.md`,
    );
    expect(convo.dir).toBe("projects/alpha");
  });

  it("ignores unknown keys like uuid and created_at", () => {
    const result = parseToc(VALID_YAML, BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No uuid-derived data anywhere on the entry.
    for (const e of result.value.entries) {
      expect(e).not.toHaveProperty("uuid");
    }
  });

  it("accepts conversation names with any filename characters", () => {
    const result = parseToc(
      "projects:\n  - name: p\n    dir: projects/p\n    conversations:\n" +
        '      - name: "weird (name) [1].md"\n        summary: [x]\n',
      BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries[0].path).toBe(
      `${BASE}/projects/p/summaries/weird (name) [1].md`,
    );
  });

  it("rejects invalid YAML", () => {
    const result = parseToc("projects: [unclosed", BASE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("toc_parse");
  });

  it("rejects a missing projects array", () => {
    const result = parseToc("foo: bar", BASE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/projects/);
  });

  it("rejects a project missing dir (name is display-only and optional)", () => {
    const result = parseToc("projects:\n  - name: p\n", BASE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/dir/);
  });

  it("parses projects without a display name fine", () => {
    const result = parseToc(
      "projects:\n  - dir: projects/x\n    docs:\n      - name: d.md\n        summary: [s]\n",
      BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries[0].dir).toBe("projects/x");
  });

  it("rejects an entry without a name", () => {
    const result = parseToc(
      "projects:\n  - name: p\n    dir: projects/p\n    conversations:\n      - summary: [x]\n",
      BASE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/name/);
  });

  it("rejects an empty TOC", () => {
    const result = parseToc("projects: []", BASE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/no entries/);
  });

  it("drops non-string summary bullets instead of failing", () => {
    const result = parseToc(
      "projects:\n  - name: p\n    dir: projects/p\n    docs:\n      - name: d.md\n        summary: [ok, 42]\n",
      BASE,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries[0].summary).toEqual(["ok"]);
  });

  it("rejects an entry whose name traverses out of baseDir", () => {
    const result = parseToc(
      "projects:\n  - dir: projects/p\n    docs:\n      - name: '../../../../etc/passwd'\n        summary: [x]\n",
      BASE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("toc_parse");
    expect(result.error.message).toMatch(/escapes baseDir/);
  });

  it("rejects an entry whose name is absolute", () => {
    const result = parseToc(
      "projects:\n  - dir: projects/p\n    docs:\n      - name: '/etc/passwd'\n        summary: [x]\n",
      BASE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("toc_parse");
  });

  it("rejects a project whose dir traverses out of baseDir", () => {
    const result = parseToc(
      "projects:\n  - dir: '../../home/user'\n    docs:\n      - name: d.md\n        summary: [x]\n",
      BASE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("toc_parse");
    expect(result.error.message).toMatch(/escapes baseDir/);
  });
});

describe("resolveEntryPath", () => {
  it("joins baseDir, project dir, kind subfolder, and verbatim name", () => {
    expect(resolveEntryPath(BASE, "projects/alpha", "doc", "workflow.md")).toBe(
      `${BASE}/projects/alpha/docs/workflow.md`,
    );
    expect(
      resolveEntryPath(
        BASE,
        "projects/alpha",
        "conversation",
        "5fe81611_notes.md",
      ),
    ).toBe(`${BASE}/projects/alpha/summaries/5fe81611_notes.md`);
  });

  it("returns null when the resolved path escapes baseDir", () => {
    // Deep enough to climb out of <base>/projects/p/docs/.
    expect(
      resolveEntryPath(BASE, "projects/p", "doc", "../../../../etc/passwd"),
    ).toBe(null);
    expect(resolveEntryPath(BASE, "projects/p", "doc", "/etc/passwd")).toBe(
      null,
    );
    expect(resolveEntryPath(BASE, "../../home/user", "doc", "d.md")).toBe(null);
  });

  it("keeps traversal names that normalize inside baseDir (names are verbatim)", () => {
    // Normalizes to <base>/projects/etc/passwd — inside the corpus, so allowed.
    expect(
      resolveEntryPath(BASE, "projects/p", "doc", "../../etc/passwd"),
    ).toBe(`${BASE}/projects/etc/passwd`);
  });
});
