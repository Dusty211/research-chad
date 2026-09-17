import { Plugin } from "@opencode/plugin";
import { AppError } from "./errors.js";
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
        editor.add({
          name: "toc_scan",
          description: tocScan.description,
          input: QUERY_SCHEMA,
          execute: broken,
        });
        editor.add({
          name: "toc_search",
          description: tocSearch.description,
          input: QUERY_SCHEMA,
          execute: broken,
        });
      });
      return;
    }

    const generateCtx = ctx as unknown as GenerateCtx;

    ctx.tool.transform((editor) => {
      editor.add({
        name: "toc_scan",
        description: tocScan.description,
        input: QUERY_SCHEMA,
        execute: async (input) => {
          try {
            const { query } = input as { query: string };
            return hitsContent(await runScan(generateCtx, opts, query));
          } catch (e) {
            return errorContent(e);
          }
        },
      });

      editor.add({
        name: "toc_search",
        description: tocSearch.description,
        input: QUERY_SCHEMA,
        execute: async (input) => {
          try {
            const { query } = input as { query: string };
            return hitsContent(await runSearch(generateCtx, opts, query));
          } catch (e) {
            return errorContent(e);
          }
        },
      });
    });
  },
});
