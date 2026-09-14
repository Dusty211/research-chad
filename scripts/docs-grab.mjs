// Fetches OpenCode V2 doc pages and saves them as clean markdown into
// opencode-docs/plugin-docs/. Pipeline: Playwright (render) -> Readability
// (extract article) -> Turndown (HTML -> GFM). Deterministic, no LLM.
//
// Usage (recommended via npm; "--" separates npm from the script's args):
//   npm run docs:grab                              # grab the default pages
//   npm run docs:grab -- -u <url> [-o <file>]...   # grab exactly the given page(s), repeatable.
//                                                  # -o may be omitted, in which case the filename is
//                                                  #  derived from the URL path; an absolute -o path
//                                                  #  writes outside plugin-docs/.
import process from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JSDOM } from "jsdom";
import { chromium } from "playwright";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import turndownPluginGfm from "turndown-plugin-gfm";

// Default [url, filename] pairs. Add a line here and re-run to snapshot a new
// page permanently; or pass -u/-o on the command line for one-off grabs.
export const DEFAULT_PAGES = [
  ["https://opencode.ai/v2/docs/build/plugins/", "plugins-overview.md"],
  ["https://opencode.ai/v2/docs/build/sdk/", "sdk-overview.md"],
  ["https://opencode.ai/v2/docs/build/client/", "client-js.md"],
  [
    "https://opencode.ai/v2/docs/build/plugins/migrate-v1/",
    "plugins-migrate-v1.md",
  ],
  ["https://opencode.ai/v2/docs/references/", "references.md"],
  ["https://opencode.ai/v2/docs/agents/", "agent-docs.md"],
  ["https://opencode.ai/v2/docs/permissions/", "permissions.md"],
  ["https://opencode.ai/v2/docs/tools/", "tools.md"],
];

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "opencode-docs",
  "plugin-docs",
);

// networkidle can hang if the site holds a connection open, so settle after
// domcontentloaded instead.
const SETTLE_MS = 500;

// Readability sometimes fails on doc layouts; fall back to the site's known
// content anchor if it does.
const FALLBACK_SELECTOR = "#docs-content";

const turndown = new TurndownService({ headingStyle: "atx" });
turndown.use(turndownPluginGfm.gfm);

// The site renders code blocks as <pre data-language="lang"><code>, optionally
// wrapped in <figure><figcaption>. Force fenced output with the language from
// data-language (falling back to the caption) instead of turndown's default
// indented blocks.
function fenceFor(node) {
  const pre = node.nodeName === "PRE" ? node : node.querySelector("pre");
  // Both rules' filters guarantee a <pre>; throw rather than emit an empty
  // block if that invariant is ever broken by a future rule.
  if (!pre) throw new Error("code fence rule matched a node with no <pre>");
  const lang =
    pre.getAttribute("data-language") ||
    node.querySelector("figcaption")?.textContent?.trim() ||
    "";
  return `\n\n\`\`\`${lang}\n${pre.textContent.trim()}\n\`\`\`\n\n`;
}

turndown.addRule("astro-code-figure", {
  filter: (node) => node.nodeName === "FIGURE" && !!node.querySelector("pre"),
  replacement: (_content, node) => fenceFor(node),
});
turndown.addRule("astro-code-pre", {
  filter: (node) => node.nodeName === "PRE" && !node.closest("figure"),
  replacement: (_content, node) => fenceFor(node),
});

// Drop inline data: images (e.g. base64 SVG icons) so they don't leak into the
// markdown as unusable blobs. Normal http(s) images are left to turndown.
turndown.addRule("drop-data-images", {
  filter: (node) =>
    node.nodeName === "IMG" &&
    (node.getAttribute("src") || "").startsWith("data:"),
  replacement: () => "",
});

function extractArticle(document) {
  const parsed = new Readability(document, { charThreshold: 200 }).parse();
  if (parsed && parsed.textContent.trim().length > 100) return parsed;
  const fallback = document.querySelector(FALLBACK_SELECTOR);
  if (!fallback) throw new Error("no article found and no fallback element");
  return { title: document.title, content: fallback.innerHTML };
}

// Converts a Readability-style { title, content } result to clean GFM. Exported
// for testing; the Playwright fetch path is intentionally not unit-tested.
export function htmlToMarkdown(parsed) {
  const dom = new JSDOM(`<html><body>${parsed.content}</body></html>`);
  const doc = dom.window.document;
  // Prefer the first H1 in the content over Readability's title, which may
  // include site branding.
  const title = (
    doc.querySelector("h1")?.textContent ??
    parsed.title ??
    "Untitled"
  ).trim();
  const markdown = turndown.turndown(doc.body.innerHTML);
  return { title, markdown: markdown.trim() };
}

async function grabPage(browser, url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(SETTLE_MS);
    const html = await page.content();
    const document = new JSDOM(html).window.document;
    return extractArticle(document);
  } finally {
    await page.close();
  }
}

// Derive a filename from a URL path, e.g. .../build/plugins/migrate-v1/ ->
// plugins-migrate-v1.md. Empty or dot-only segments are dropped.
export function filenameFromUrl(url) {
  const segs = new URL(url).pathname.split("/").filter((s) => s && s !== ".");
  const base = (segs.at(-1) ?? "index").replace(/\.html?$/, "");
  return `${base}.md`;
}

const HELP = `Usage:
  npm run docs:grab                              Grab the default pages.
  npm run docs:grab -- -u <url> [-o <file>]...
                                                 Grab exactly the given page(s); repeat -u for
                                                 more. The "--" separates npm from the script's
                                                 args. -o is optional (filename defaults to the
                                                 URL's last path segment + .md).`;

// One page item: required -u <url>, optional -o <file>. Values may not start
// with "-" so flags are never mistaken for values. The separator space is part
// of the optional group so an item without -o still ends cleanly. Unanchored on
// purpose: ^$ cannot be combined with global iteration in JS, so we match all
// items and then verify they tile the input with no gaps.
const ITEM_RE = /(-u|--url) (\S+)(?: (-o|--out) (\S+))?/g;

// Parses argv as one or more page items, left to right. Only passes if the
// items tile the entire input (no leading/trailing/gap tokens) and every URL
// validates; throws otherwise (the caller prints help). Returns
// [url, filename|null] pairs.
export function parsePages(argv) {
  const joined = argv.join(" ");
  const pages = [];
  // Items are separated by exactly one space in the joined string, so the next
  // item must start at (previous end + 1). Any other offset means a stray or
  // missing token.
  let expected = 0;
  for (const match of joined.matchAll(ITEM_RE)) {
    if (match.index !== expected) throw new Error("invalid arguments");
    const [, , url, , filename] = match;
    try {
      new URL(url);
    } catch {
      throw new Error(`invalid URL: ${url}`);
    }
    pages.push([url, filename ?? null]);
    expected = match.index + match[0].length + 1;
  }
  if (pages.length === 0 || expected - 1 !== joined.length) {
    throw new Error("invalid arguments");
  }
  return pages;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }
  // No args means "run the defaults"; parsePages is only invoked when there is
  // something to parse.
  let explicitPages = [];
  if (argv.length > 0) {
    try {
      explicitPages = parsePages(argv);
    } catch (err) {
      console.error(`${err.message}\n\n${HELP}`);
      process.exit(1);
    }
  }
  const pages = (explicitPages.length > 0 ? explicitPages : DEFAULT_PAGES).map(
    ([url, filename]) => [url, filename ?? filenameFromUrl(url)],
  );
  // Resolve output paths up front and reject collisions so two pages can never
  // silently overwrite the same file.
  const seen = new Map();
  for (const [url, filename] of pages) {
    const outPath = path.isAbsolute(filename)
      ? filename
      : path.join(OUT_DIR, filename);
    const prev = seen.get(outPath);
    if (prev) {
      console.error(
        `duplicate output path ${outPath} (from ${prev} and ${url})`,
      );
      process.exit(1);
    }
    seen.set(outPath, url);
  }
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const failures = [];
  try {
    for (const [url, filename] of pages) {
      try {
        const parsed = await grabPage(browser, url);
        const { title, markdown } = htmlToMarkdown(parsed);
        const out = `# ${title}\n\nSource: ${url}\n\n${markdown}\n`;
        const outPath = path.isAbsolute(filename)
          ? filename
          : path.join(OUT_DIR, filename);
        await mkdir(path.dirname(outPath), { recursive: true });
        await writeFile(outPath, out, "utf8");
        console.log(`ok   ${filename}  (${markdown.length} chars)`);
      } catch (err) {
        failures.push({ url, filename, err });
        console.error(`FAIL ${filename}: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} page(s) failed.`);
    process.exit(1);
  }
}

// Run only when executed directly, so the module can be imported (e.g. for
// DEFAULT_PAGES) without side effects.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
