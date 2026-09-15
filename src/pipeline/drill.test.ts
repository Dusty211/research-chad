import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrill } from "./drill.js";
import type { GenerateCtx } from "./model.js";
import type { ChadOptions } from "../options.js";
import type { TocEntry } from "../types.js";

const MATCH_REASON =
  "Covers garden soil preparation. Gives exact steps. References the spring planting guide.";

function docEntry(name: string, path: string): TocEntry {
  return {
    kind: "doc",
    name,
    path,
    dir: "projects/alpha",
    summary: [],
  };
}

function convoEntry(name: string, path: string): TocEntry {
  return {
    kind: "conversation",
    name,
    path,
    dir: "projects/alpha",
    summary: [],
  };
}

describe("runDrill", () => {
  let tmp: string;
  let opts: ChadOptions;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "research-chad-drill-"));
    const docsDir = join(tmp, "projects/alpha/docs");
    const summariesDir = join(tmp, "projects/alpha/summaries");
    await mkdir(docsDir, { recursive: true });
    await mkdir(summariesDir, { recursive: true });
    await writeFile(
      join(docsDir, "garden.md"),
      "# Garden\nsoil preparation details",
      "utf8",
    );
    await writeFile(
      join(docsDir, "cooking.md"),
      "# Cooking\nbaking notes",
      "utf8",
    );
    // Filename with an inert uuid-looking prefix — just a filename.
    await writeFile(
      join(summariesDir, "deadbeef_garden-chat.md"),
      "# Chat\ngarden discussion",
      "utf8",
    );
    opts = {
      tocPath: join(tmp, "TOC.yaml"), // unused by runDrill
      baseDir: tmp,
      availableContext: 262_144,
      model: { providerID: "p", id: "m" },
    };
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("keeps only matching candidates, at depth drilldown", async () => {
    const prompts: string[] = [];
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          prompts.push(prompt);
          const isGarden = prompt.includes("# Garden\nsoil preparation");
          return {
            text: JSON.stringify(
              isGarden
                ? { match: true, matchReason: MATCH_REASON }
                : { match: false, matchReason: null },
            ),
          };
        },
      },
    };

    const hits = await runDrill(ctx, opts, "garden soil", [
      docEntry("garden.md", join(tmp, "projects/alpha/docs/garden.md")),
      docEntry("cooking.md", join(tmp, "projects/alpha/docs/cooking.md")),
    ]);

    expect(hits).toEqual([
      {
        dir: "projects/alpha",
        path: join(tmp, "projects/alpha/docs/garden.md"),
        name: "garden.md",
        kind: "doc",
        depth: "drilldown",
        matchReason: MATCH_REASON,
      },
    ]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Query: garden soil");
  });

  it("reads conversation files by their verbatim filename (uuid prefix inert)", async () => {
    const ctx: GenerateCtx = {
      generate: {
        text: async () => ({
          text: JSON.stringify({ match: true, matchReason: MATCH_REASON }),
        }),
      },
    };

    const hits = await runDrill(ctx, opts, "garden", [
      convoEntry(
        "deadbeef_garden-chat.md",
        join(tmp, "projects/alpha/summaries/deadbeef_garden-chat.md"),
      ),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("conversation");
    expect(hits[0].name).toBe("deadbeef_garden-chat.md");
  });

  it("runs the overflow fold for files over budget", async () => {
    const bigDir = join(tmp, "projects/alpha/docs");
    const bigContent = Array.from(
      { length: 100 },
      (_, i) => `line ${i} about garden soil`,
    ).join("\n");
    await writeFile(join(bigDir, "big.md"), bigContent, "utf8");

    // budget ≈ availableContext bytes (3.5 * 0.218 ≈ 0.76); 1000 → ~763 bytes < 3KB file.
    const smallOpts = { ...opts, availableContext: 1_000 };

    const prompts: string[] = [];
    const ctx: GenerateCtx = {
      generate: {
        text: async ({ prompt }) => {
          prompts.push(prompt);
          if (prompt.includes("Read part")) {
            return {
              text: JSON.stringify({
                relevant: true,
                evidence: "part mentions garden soil preparation",
              }),
            };
          }
          // Final fold call.
          return {
            text: JSON.stringify({ match: true, matchReason: MATCH_REASON }),
          };
        },
      },
    };

    const hits = await runDrill(ctx, smallOpts, "garden soil", [
      docEntry("big.md", join(bigDir, "big.md")),
    ]);

    expect(hits).toHaveLength(1);
    expect(hits[0].matchReason).toBe(MATCH_REASON);
    const partCalls = prompts.filter((p) => p.includes("Read part"));
    expect(partCalls.length).toBeGreaterThanOrEqual(2);
    expect(prompts.at(-1)).toContain("You reviewed a document part by part");
    // The distill was threaded into later parts.
    expect(partCalls.at(-1)).toContain("So far found in earlier parts");
  });

  it("hard-fails when the model output is invalid twice", async () => {
    const ctx: GenerateCtx = {
      generate: { text: async () => ({ text: "not json" }) },
    };
    await expect(
      runDrill(ctx, opts, "q", [
        docEntry("garden.md", join(tmp, "projects/alpha/docs/garden.md")),
      ]),
    ).rejects.toMatchObject({ code: "model_output" });
  });

  it("hard-fails naming the path when a file is missing", async () => {
    const ctx: GenerateCtx = {
      generate: { text: async () => ({ text: "{}" }) },
    };
    await expect(
      runDrill(ctx, opts, "q", [
        docEntry("ghost.md", join(tmp, "projects/alpha/docs/ghost.md")),
      ]),
    ).rejects.toThrow(/ghost\.md/);
  });
});
