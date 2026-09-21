# AGENTS.md

## Git is read-only

- You are only permitted to use Git operations that are read only and do not modify anything.
- Never perform any operation with Git which modifies the git state or the data on disk.

## Design priorities

- You must strictly prioritize code quality over convenience. Never take the "easy way out" because doing it properly is "too much work" or would "take too long."
- You must strictly use idiomatic JS/TS patterns and conventions.
- You must always default to fundemental software engineering principles.
- Always do things the correct canonical way.
- Technical debt is NEVER EVER an acceptable trade-off under any circumstance.
- Don't repeat yourself (DRY)
- Always use the principle of separation of concerns.
- Prefer pure functions always.
- Failures always default to hard and loud unless there is a valid reason otherwise.
- Code should be broken into multiple files correctly. If we have a file with massive line counts, that file should be considered as a candidate to be broken into multiple files.

## Working guidelines

- Use consistent best practices and consistent patterns across the project.
- Use DRY (don't repeat yourself) practices where it makes sense.
- Quality comes first before speed.
- Do not keep history in code comments.
- If code comments exist, they should document things which are not obvious from the code itself.
- all documentation and comment updates ship at the same time as their related code changes.

## Opencode-docs

- There is a specific directory to be used with Opencode's references feature. Consult the `opencode-docs` reference at: `opencode-docs/INDEX.md` for the index.
- `opencode-docs/plugin-docs/` is populated by `npm run docs:grab` (Playwright + Readability + Turndown). Re-run it to refresh; add a page permanently by editing `DEFAULT_PAGES` in `scripts/docs-grab.mjs`, or one-off via `npm run docs:grab -- -u <url> [-o <file>]` (the `--` separates npm from the script's args).

## What this project is

An OpenCode v2 plugin (`@opencode/plugin` peer dep). Single source file `src/index.ts` exports a `Plugin.define(...)` default that registers tools via `ctx.tool.transform`. `dist/` is build output — never edit it; run `npm run build` to regenerate.

## Commands

- `npm install` — install dev deps
- `npm run build` — `tsc -p tsconfig.build.json` → `dist/` (the published artifact; tests are excluded from the build)
- `npm run typecheck` — `tsc --noEmit -p tsconfig.json`; checks ALL of `src/` including test files. The editor and this must always agree — if you see an error in the editor, it must also fail here.
- `npm run check` — the one-command gate: `lint -> typecheck -> format:check -> test`. Run this before considering work done.
- Individual steps: `npm run lint` / `lint:fix`, `npm run typecheck`, `npm run format` / `format:check`, `npm test` (or `test:watch`)
- Single test: `npx vitest run -t "test name substring"` or `npx vitest run src/index.test.ts`
- `npm run docs:grab` — fetch OpenCode V2 doc pages into `opencode-docs/plugin-docs/`; `-- --help` for usage (no args = defaults, `-u <url> [-o <file>]` for specific pages)

## Tooling notes

- ESLint 10 flat config in `eslint.config.js`: typescript-eslint recommended + Prettier. The prettier plugin's preset uses the legacy `extends` key which flat config rejects, so it is expanded manually in that file — don't "simplify" it back to `eslintPluginPrettier.configs.recommended`.
- Prettier runs pure defaults (no `.prettierrc`). `lint --fix` also formats.
- Vitest 5; tests live next to source as `src/*.test.ts`. Two tsconfigs on purpose: `tsconfig.json` is the typecheck scope (everything in `src/`, no emit options) and `tsconfig.build.json` extends it just for emitting `dist/` (adds outDir/rootDir/declaration, excludes `**/*.test.ts`). Don't merge them back — "what we publish" and "what we typecheck" are different concerns.
- `scripts/` is plain `.mjs`, intentionally outside the TS build/typecheck scope but inside lint + format. `opencode-docs/` is ignored by both ESLint and Prettier — it's external reference content that must never be linted, formatted, or rewritten.

## Gotchas

- The plugin runs under Bun in OpenCode, but tests run under Node: keep `src/` free of `Bun.*` globals so both can import it (`node:` builtins work in both).
- Tool `input` arrives typed as `unknown` by design — validate/cast by hand in `execute`, don't rely on JSON Schema inference.
- `module: NodeNext` + ESM: relative imports in `src/` need explicit `.js` extensions (even for `.ts` files).
