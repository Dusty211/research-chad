import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGES,
  parsePages,
  filenameFromUrl,
  htmlToMarkdown,
} from "./docs-grab.mjs";

// The Playwright fetch path (main/grabPage) is intentionally not unit-tested:
// it needs a browser and the live site. These suites pin the pure logic that
// actually carries the contract — CLI parsing, filename derivation, and the
// HTML->GFM guarantees that make the output "clean".

describe("parsePages", () => {
  it("parses a single -u item with no -o", () => {
    expect(parsePages(["-u", "https://x.com/a/"])).toEqual([
      ["https://x.com/a/", null],
    ]);
  });

  it("pairs -o with its preceding -u", () => {
    expect(parsePages(["-u", "https://x.com/a/", "-o", "a.md"])).toEqual([
      ["https://x.com/a/", "a.md"],
    ]);
  });

  it("parses multiple items in order, mixing -o presence", () => {
    expect(
      parsePages([
        "-u",
        "https://x.com/a/",
        "-o",
        "a.md",
        "-u",
        "https://x.com/b/",
      ]),
    ).toEqual([
      ["https://x.com/a/", "a.md"],
      ["https://x.com/b/", null],
    ]);
  });

  it("accepts the long flag forms --url / --out", () => {
    expect(parsePages(["--url", "https://x.com/a/", "--out", "a.md"])).toEqual([
      ["https://x.com/a/", "a.md"],
    ]);
  });

  it("rejects a bare -o with no preceding -u", () => {
    expect(() => parsePages(["-o", "a.md"])).toThrow();
  });

  it("rejects -o appearing before any -u", () => {
    expect(() => parsePages(["-o", "a.md", "-u", "https://x.com/"])).toThrow();
  });

  it("rejects a value that starts with a dash (flag mistaken for value)", () => {
    expect(() => parsePages(["-u", "--weird"])).toThrow();
  });

  it("rejects a trailing -u with no value", () => {
    expect(() => parsePages(["-u"])).toThrow();
  });

  it("rejects an unknown argument", () => {
    expect(() => parsePages(["--only", "-u", "https://x.com/"])).toThrow();
  });

  it("rejects a stray token between items", () => {
    expect(() =>
      parsePages(["-u", "https://x.com/a/", "junk", "-u", "https://x.com/b/"]),
    ).toThrow();
  });

  it("rejects a stray token after the last item", () => {
    expect(() => parsePages(["-u", "https://x.com/a/", "junk"])).toThrow();
  });

  it("rejects a duplicate -o on the same item", () => {
    expect(() =>
      parsePages(["-u", "https://x.com/a/", "-o", "a.md", "-o", "b.md"]),
    ).toThrow();
  });

  it("rejects an empty-string value", () => {
    expect(() => parsePages(["-u", ""])).toThrow();
  });

  it("rejects a URL that does not parse", () => {
    expect(() => parsePages(["-u", "not-a-url"])).toThrow(/invalid URL/);
  });

  it("rejects a URL value containing a space", () => {
    expect(() => parsePages(["-u", "https://x.com/a b/"])).toThrow();
  });
});

describe("filenameFromUrl", () => {
  it("uses the last path segment plus .md", () => {
    expect(filenameFromUrl("https://x.com/build/plugins/migrate-v1/")).toBe(
      "migrate-v1.md",
    );
  });

  it("strips a trailing .html", () => {
    expect(filenameFromUrl("https://x.com/a/index.html")).toBe("index.md");
  });

  it("strips a trailing .htm", () => {
    expect(filenameFromUrl("https://x.com/b/page.htm")).toBe("page.md");
  });

  it("falls back to index.md for a root/empty path", () => {
    expect(filenameFromUrl("https://x.com/")).toBe("index.md");
  });

  it("keeps a segment without an extension and appends .md", () => {
    expect(filenameFromUrl("https://x.com/c/d")).toBe("d.md");
  });
});

describe("htmlToMarkdown", () => {
  it("fences a bare <pre> with its data-language", () => {
    const { markdown } = htmlToMarkdown({
      title: "T",
      content: '<pre data-language="jsonc"><code>{\n  "a": 1\n}</code></pre>',
    });
    expect(markdown).toContain("```jsonc");
    expect(markdown).toContain('{\n  "a": 1\n}');
    // Must be a fenced block, not turndown's default indented code.
    expect(markdown).not.toMatch(/^\s{4}\{/m);
  });

  it("collapses a figure-wrapped code block into one fenced block", () => {
    const { markdown } = htmlToMarkdown({
      title: "T",
      content:
        "<figure><figcaption>ts</figcaption>" +
        '<pre data-language="ts"><code>const x = 1;</code></pre></figure>',
    });
    expect(markdown).toContain("```ts");
    expect(markdown).toContain("const x = 1;");
    // No figure chrome leaking through.
    expect(markdown).not.toContain("<figure");
    expect(markdown).not.toContain("astro-code");
  });

  it("prefers the first H1 in the content over the passed title", () => {
    const { title } = htmlToMarkdown({
      title: "Branded | Site",
      content: "<h1>Real Heading</h1><p>body</p>",
    });
    expect(title).toBe("Real Heading");
  });

  it("falls back to the passed title when there is no H1", () => {
    const { title } = htmlToMarkdown({
      title: "Only Title",
      content: "<p>no heading here</p>",
    });
    expect(title).toBe("Only Title");
  });

  it("does not leak base64 image data or nav chrome into the output", () => {
    const { markdown } = htmlToMarkdown({
      title: "T",
      content:
        '<nav><a href="/">home</a></nav>' +
        '<img src="data:image/svg+xml;base64,PHN2Zz4=" />' +
        "<p>visible text</p>",
    });
    expect(markdown).toContain("visible text");
    expect(markdown).not.toContain("base64");
    expect(markdown).not.toContain("<nav");
  });

  it("converts headings to atx style and lists to GFM", () => {
    const { markdown } = htmlToMarkdown({
      title: "T",
      content: "<h2>Section</h2><ul><li>one</li><li>two</li></ul>",
    });
    expect(markdown).toContain("## Section");
    expect(markdown).toMatch(/[-*]\s+one/);
  });
});

describe("DEFAULT_PAGES", () => {
  it("is a non-empty list of [validUrl, filename] pairs", () => {
    expect(DEFAULT_PAGES.length).toBeGreaterThan(0);
    for (const pair of DEFAULT_PAGES) {
      expect(pair).toHaveLength(2);
      const [url, filename] = pair;
      expect(typeof url).toBe("string");
      expect(() => new URL(url)).not.toThrow();
      expect(typeof filename).toBe("string");
      expect(filename.length).toBeGreaterThan(0);
    }
  });
});
