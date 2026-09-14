# research-chad

An [OpenCode](https://opencode.ai) v2 plugin that registers a `read_verbatim` tool: it reads a local file and returns its full content with no truncation. This is an initial POC for the actual goal which is retrieving data from local LLM-distilled files via an LLM-generated table of contents.

## Install

```bash
npm install
```

## Build

```bash
npm run build   # tsc -> dist/
```

The package entrypoint is `dist/index.js` (built artifact; commit nothing to `dist/`).

## Usage

Add the plugin to your OpenCode config so the `read_verbatim` tool becomes available to the model:

```json
{
  "plugin": ["research-chad"]
}
```

The tool takes a single input:

- `path` (string, required) — path to the local file to read.

## Development

- Source lives in `src/index.ts`; see [AGENTS.md](./AGENTS.md) for repo conventions and gotchas.
- There is no test or lint setup; verify with `npx tsc --noEmit`.

## License

[MIT](./LICENSE)
