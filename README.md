# research-chad

An [OpenCode](https://opencode.ai) v2 plugin that registers a `read_verbatim` tool: it reads a local file and returns its full content with no truncation. This is an initial POC for the actual goal which is retrieving data from local LLM-distilled files via an LLM-generated table of contents.

## Install

```bash
npm install
```

## Build & verify

```bash
npm run build    # tsc -> dist/
npm run check    # lint + typecheck + format check + tests, in one command
```

The package entrypoint is `dist/index.js` (built artifact; commit nothing to `dist/`).

## Usage

Add the plugin to your OpenCode config (`opencode.json`) so the `read_verbatim` tool becomes available to the model. Once published, use the package name; for local development, point at a path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["research-chad"],
}
```

The tool takes a single input:

- `path` (string, required) — path to the local file to read.

## Development

- Source lives in `src/index.ts`; tests in `src/*.test.ts` (Vitest). See [AGENTS.md](./AGENTS.md) for repo conventions and gotchas.
- Lint/format with ESLint + Prettier; verify everything with `npm run check`.

## License

[MIT](./LICENSE)
