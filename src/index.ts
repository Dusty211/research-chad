import { Plugin } from "@opencode/plugin";
import { AppError, InvalidInputError } from "./errors.js";
import { validateOptions, type ChadOptions } from "./options.js";
import { runScan } from "./pipeline/scan.js";
import { runSearch } from "./pipeline/search.js";
import type { GenerateCtx } from "./pipeline/model.js";
import type { Hit, ToolError } from "./types.js";

type ToolResult = { content: string };

const tocScan = {
  description:
    "Scan the research TOC for entries relevant to a query. Returns a JSON array of hits (dir, path, name, kind, depth 'toc', matchReason).",
};

const tocSearch = {
  description:
    "Full research search: scan the TOC for entries relevant to a query, then read each candidate file and confirm relevance. Returns a JSON array of hits (depth 'drilldown').",
};

/** Tools return JSON text: either the hits array or a structured error. */
function hitsContent(hits: Hit[]): ToolResult {
  return { content: JSON.stringify(hits) };
}

function errorContent(error: unknown): ToolResult {
  const e: ToolError =
    error instanceof AppError
      ? { code: error.code, message: error.message }
      : { code: "unknown", message: String(error) };
  return { content: JSON.stringify({ ok: false, error: e }) };
}

const QUERY_SCHEMA = {
  type: "object" as const,
  properties: { query: { type: "string" } },
  required: ["query"],
  additionalProperties: false,
};

/** Tool input arrives typed unknown by the plugin API; validate it by hand. */
function extractQuery(input: unknown): string {
  if (typeof input !== "object" || input === null) {
    throw new InvalidInputError("tool input must be an object");
  }
  const { query } = input as { query?: unknown };
  if (typeof query !== "string" || query.length === 0) {
    throw new InvalidInputError("query must be a non-empty string");
  }
  return query;
}

/** The tools this plugin registers, in registration order. */
const TOOLS = [
  { name: "toc_scan", description: tocScan.description },
  { name: "toc_search", description: tocSearch.description },
] as const;

export default Plugin.define({
  id: "chad",
  setup(ctx) {
    let opts: ChadOptions;
    try {
      opts = validateOptions(ctx.options);
    } catch (e) {
      // Misconfiguration is fatal to the plugin; register the TOC tools as hard
      // errors so the failure is visible at call time instead of a silent no-op.
      const broken = async (): Promise<ToolResult> => errorContent(e);
      ctx.tool.transform((editor) => {
        for (const tool of TOOLS) {
          editor.add({ ...tool, input: QUERY_SCHEMA, execute: broken });
        }
      });
      return;
    }

    const generateCtx = ctx as unknown as GenerateCtx;

    const executes: Record<
      (typeof TOOLS)[number]["name"],
      (input: unknown) => Promise<ToolResult>
    > = {
      toc_scan: async (input) => {
        try {
          const query = extractQuery(input);
          return hitsContent(await runScan(generateCtx, opts, query));
        } catch (e) {
          return errorContent(e);
        }
      },
      toc_search: async (input) => {
        try {
          const query = extractQuery(input);
          return hitsContent(await runSearch(generateCtx, opts, query));
        } catch (e) {
          return errorContent(e);
        }
      },
    };

    ctx.tool.transform((editor) => {
      for (const tool of TOOLS) {
        editor.add({
          ...tool,
          input: QUERY_SCHEMA,
          execute: executes[tool.name],
        });
      }
    });
  },
});
