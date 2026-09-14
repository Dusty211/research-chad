# AGENTS.md

## What this is

An OpenCode v2 plugin (`@opencode/plugin` peer dep). Single source file `src/index.ts` exports a `Plugin.define(...)` default that registers tools via `ctx.tool.transform`. `dist/` is build output — never edit it; run `npm run build` to regenerate.

## Commands

- `npm install` — install dev deps (TypeScript, `@opencode/plugin`, `@types/bun`)
- `npm run build` — the only script; runs `tsc -p tsconfig.json` → `dist/`
- No test, lint, or typecheck scripts exist. Verify with `npx tsc --noEmit`.

## Gotchas

- Code uses Bun-native APIs (`Bun.file(...)`); `@types/bun` is the declared types package even though it's an npm project. Don't "fix" this to Node APIs without checking runtime expectations.
- Tool `input` arrives typed as `unknown` by design — validate/cast by hand in `execute`, don't rely on JSON Schema inference.
- `module: NodeNext` + ESM: relative imports in `src/` need explicit file extensions.
- README is currently empty; `package.json` description is the only doc of intent.
