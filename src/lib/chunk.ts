import { err, ok, ChunkBudgetError, type Result } from "../errors.js";
import type { Chunk, Part, TocEntry } from "../types.js";

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Render one TOC entry as a block for chunk prompts. */
export function renderEntryBlock(entry: TocEntry): string {
  const bullets = entry.summary.map((s) => `- ${s}`).join("\n");
  return `=== ${entry.kind.toUpperCase()}: ${entry.path} ===\n${bullets}\n\n`;
}

/**
 * Greedily pack entry blocks into chunks of at most maxBytes.
 * Entries keep TOC order; an entry is never split across chunks.
 */
export function packEntries(
  entries: TocEntry[],
  maxBytes: number,
): Result<Chunk[]> {
  const blocks = entries.map((e) => ({ entry: e, block: renderEntryBlock(e) }));

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentPaths: string[] = [];
  let currentSize = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join("");
    chunks.push({
      index: chunks.length,
      total: 0, // set once all chunks are known (see below)
      text,
      byteLength: byteLength(text),
      paths: currentPaths,
    });
    current = [];
    currentPaths = [];
    currentSize = 0;
  };

  for (const { entry, block } of blocks) {
    const size = byteLength(block);
    if (size > maxBytes) {
      return err(
        new ChunkBudgetError(
          `entry '${entry.name}' is ${size} bytes, exceeding the ${maxBytes}-byte chunk budget`,
        ),
      );
    }
    if (currentSize > 0 && currentSize + size > maxBytes) flush();
    current.push(block);
    currentPaths.push(entry.path);
    currentSize += size;
  }
  flush();

  chunks.forEach((c) => {
    c.total = chunks.length;
  });
  return ok(chunks);
}

/**
 * Slice file text into parts of at most maxBytes, breaking only on line
 * boundaries. A single line longer than maxBytes is its own part (the caller's
 * budget must be sized so this cannot happen for real data).
 */
export function sliceFile(text: string, maxBytes: number): Result<Part[]> {
  if (byteLength(text) === 0) {
    return err(new ChunkBudgetError("cannot slice empty file content"));
  }

  const lines = text.split("\n");
  // Lines are reassembled with "\n", so newlines between lines within a part are
  // preserved. A trailing newline in the source splits to a final "" element,
  // which re-materializes as that part's trailing newline on join — so joining
  // the parts back with "\n" reproduces the original text exactly.
  const parts: Part[] = [];
  let current: string[] = [];
  let currentSize = 0;

  const flush = () => {
    if (current.length === 0) return;
    const body = current.join("\n");
    parts.push({
      index: parts.length,
      total: 0,
      text: body,
      byteLength: byteLength(body),
    });
    current = [];
    currentSize = 0;
  };

  for (const line of lines) {
    const size = byteLength(line) + (current.length > 0 ? 1 : 0); // +1 for the joining newline
    if (currentSize > 0 && currentSize + size > maxBytes) flush();
    current.push(line);
    currentSize += size;
  }
  flush();

  parts.forEach((p) => {
    p.total = parts.length;
  });
  return ok(parts);
}
