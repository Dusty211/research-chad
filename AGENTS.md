# AGENTS.md

## What this is

An OpenCode v2 plugin (`@opencode/plugin` peer dep). Single source file `src/index.ts` exports a `Plugin.define(...)` default that registers tools via `ctx.tool.transform`. `dist/` is build output — never edit it; run `npm run build` to regenerate.

## Commands

- `npm install` — install dev deps
- `npm run build` — `tsc -p tsconfig.build.json` → `dist/` (the published artifact; tests are excluded from the build)
- `npm run typecheck` — `tsc --noEmit -p tsconfig.json`; checks ALL of `src/` including test files. The editor and this must always agree — if you see an error in the editor, it must also fail here.
- `npm run check` — the one-command gate: `lint -> typecheck -> format:check -> test`. Run this before considering work done.
- Individual steps: `npm run lint` / `lint:fix`, `npm run typecheck`, `npm run format` / `format:check`, `npm test` (or `test:watch`)
- Single test: `npx vitest run -t "test name substring"` or `npx vitest run src/index.test.ts`

## Tooling notes

- ESLint 10 flat config in `eslint.config.js`: typescript-eslint recommended + Prettier. The prettier plugin's preset uses the legacy `extends` key which flat config rejects, so it is expanded manually in that file — don't "simplify" it back to `eslintPluginPrettier.configs.recommended`.
- Prettier runs pure defaults (no `.prettierrc`). `lint --fix` also formats.
- Vitest 5; tests live next to source as `src/*.test.ts`. Two tsconfigs on purpose: `tsconfig.json` is the typecheck scope (everything in `src/`, no emit options) and `tsconfig.build.json` extends it just for emitting `dist/` (adds outDir/rootDir/declaration, excludes `**/*.test.ts`). Don't merge them back — "what we publish" and "what we typecheck" are different concerns.

## Gotchas

- Tests run under Node, not Bun: don't use `Bun.*` APIs in `src/` — use `node:` builtins (e.g. `node:fs/promises`). `@types/bun` is still declared for types; that's fine.
- Tool `input` arrives typed as `unknown` by design — validate/cast by hand in `execute`, don't rely on JSON Schema inference.
- `module: NodeNext` + ESM: relative imports in `src/` need explicit `.js` extensions (even for `.ts` files).
