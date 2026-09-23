# research-chad

An [OpenCode](https://opencode.ai) v2 plugin that retrieves data from local LLM-distilled files via an LLM-generated table of contents. It registers two tools:

- `toc_scan` — scans the TOC for entries relevant to a query. Returns a JSON array of hits (`dir`, `path`, `name`, `kind`, `depth: "toc"`, `matchReason`).
- `toc_search` — full search: scans the TOC, then reads each candidate file and confirms relevance. Returns a JSON array of hits (`depth: "drilldown"`).

Both tools take a single input:

- `query` (string, required) — what you are looking for.

On failure both tools return a structured error object instead of a hits array: `{ "ok": false, "error": { "code", "message" } }`. Error codes: `toc_parse`, `chunk_budget`, `model_output`, `pipeline`, `options`, `fs`, `invalid_input`, `unknown`. A `pipeline` error means one or more items (TOC chunks or drill candidates) failed mid-run; its message lists every failed item (position and reason) plus how many items began executing before the run was abandoned. Failed model calls and missing candidate files always surface wrapped in `pipeline` — the specific cause appears in the message, so `model_output` never reaches you as a top-level tool code for those cases. A top-level `fs` error means the TOC file itself could not be read (missing or unreadable path). An `invalid_input` error means the call's arguments did not match the tool schema (a malformed `query`).

## Setup

OpenCode installs the plugin itself — you only reference it in your config (`opencode.json` or `opencode.jsonc`) and provide its options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "research-chad",
      "options": {
        // Absolute path to the TOC.yaml for your research corpus.
        "tocPath": "/path/to/corpus/TOC.yaml",
        // Base directory that TOC project dirs are relative to.
        "baseDir": "/path/to/corpus",
        // Model context window in tokens; drives the chunk byte budget.
        "availableContext": 262144,
        // Model used for all generate calls.
        "model": { "providerID": "anthropic", "id": "claude-sonnet-4-5" },

        // Optional: max concurrent model calls (default 1, sequential, hard
        // cap 10). Raise this only if your provider/backend can serve
        // parallel inferences; set it conservatively relative to its rate
        // limits. In-flight calls are bounded by the batch size anyway, so
        // values above the cap buy nothing.
        "inferenceConcurrency": 1,
        // Optional: min ms between dispatching new model calls (default 0,
        // no throttle). Applies to every individual call — including the first
        // batch of concurrent ones. A dispatch-spacing valve, not a quota limiter.
        "inferenceRateLimitMs": 0,
      },
    },
  ],
}
```

The first four options are required; `inferenceConcurrency` and `inferenceRateLimitMs` are optional (defaults shown). After adding or changing the config, restart the OpenCode service (`opencode service restart`) to pick it up.

Plugin options are machine-specific (your corpus paths, your model), so keep them out of any committed config. OpenCode merges `plugins` arrays across config layers (lowest to highest precedence: `~/.config/opencode/opencode.json`, then the project `opencode.json`, then `.opencode/opencode.json`). Put the plugin entry in a layer you don't commit — for this repo, `.opencode/opencode.json` is gitignored for exactly this purpose. Committed configs should carry only shared settings (such as `references`).

## Errors

If any option is missing or invalid, both tools are registered as hard errors: every call returns `{ "ok": false, "error": { "code": "options", ... } }` with the specific validation message. Fix the config and restart the service.

TOC entries must resolve to files inside `baseDir`; entries whose paths escape it (traversal or absolute `dir`/`name`) are rejected at parse time with a `toc_parse` error.

## Development

- Source lives in `src/`; tests in `src/*.test.ts` (Vitest). See [AGENTS.md](./AGENTS.md) for repo conventions and gotchas.
- `npm run check` runs lint, typecheck, format check, and tests in one command; `npm run build` emits the published artifact to `dist/`.

## License

[MIT](./LICENSE)
