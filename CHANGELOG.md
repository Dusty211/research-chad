# Changelog

All notable changes to this project are documented in this file.

## [0.1.1] - 2026-09-23

### Added

- CHANGELOG.md with full version history

## [0.1.0] - 2026-09-22

### Added

- `toc_scan` tool
- `toc_search` tool
- Concurrency pool + rate-limit valve for inference dispatch (`inferenceConcurrency`, `inferenceRateLimitMs` plugin options)
- All-or-nothing pipeline settlement: `pipeline` errors list every failed item with position and reason
- Config layering: shared `references` committed; private plugin deployment config gitignored (`.opencode/opencode.json`)
- Local testing ritual documented: tgz test loop → publish → flip to registry spec

### Removed

- `read_verbatim` tool

### Fixed

- Flaky drill test: replaced event-loop clock pump with a deterministic gate-injection wiring test
- Full code-review pass across concurrency, validation, and error handling

## [0.0.1] - 2026-09-14

### Added

- Initial plugin skeleton
- `read_verbatim` tool
