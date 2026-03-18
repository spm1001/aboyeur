# Changelog

## [0.1.0] - 2026-03-18

Batterie-wide consistency pass: docs consolidation, CI, licensing, versioning.

### Added
- Plugin manifest for marketplace installability

### Fixed
- Permanent dedup blocking messages, terminal restore on exit
- Mesh message flooding: dedup at both bridge and injection layers

## 2026-03-15 — Mesh Hardening

### Added
- Walkie-talkie backchannel and mesh injection hardening
- Conductor mesh trigger source for daemon
- Mesh-awareness documentation: safe-send pattern, sidecar restart
- Claude-mesh shim for cross-machine use
- Conductor mesh setup guide for cross-machine deployment

### Changed
- TS bridge replaces Python, mesh identity auto-naming, structured event log
- PTY mesh wrapper and TypeScript conductor bridge
- Gate mesh injection on prompt-idle (Enter + 10s quiet)

### Fixed
- Bridge auth on macOS via Keychain credential reading
- ExecSync timeout with exponential backoff for bridge auth
- Fresh auth on reconnect, graceful error handling

## 2026-03-14 — Conductor Mesh Proof-of-Concept

### Added
- Two Claude Code sessions communicate via Anthropic bridge (mesh PoC)
- Status broadcasting feature request from cc-office

## 2026-03-06–07 — Daemon Architecture

### Added
- Three-tier architecture with integration tests
- Per-context FIFO queue with concurrency limits
- SQLite trigger table and polling loop
- `spawnAgent()` primitive for Claude session spawning

### Changed
- Redesigned architecture: daemon + conductor, Gueridon spawn pattern
- Wired daemon integration, fixed permission mode

## 2026-02-15 — Kitchen Rename

### Changed
- Renamed arc to bon, claude-suite to trousse across all files
- Added status block and Batterie de Savoir docs link to README

## 2026-02-07 — Initial Release

### Added
- Session orchestrator for worker/reflector cycles
- Orchestration pattern documentation (HOW_WE_BUILT_ARC.md)
