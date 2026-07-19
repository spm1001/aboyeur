# Changelog

## [0.2.1] - 2026-07-19

Fixed the same-id double-server war (aby-suwawo).

### Fixed
- Two conductor servers deriving the same agentId (e.g. a project `.mcp.json`
  server AND the sonnette plugin server in one cwd) no longer flap forever —
  each successful reconnect re-armed `recoveryAttempted`, so the yield + health-
  check-revive fixes combined into a perpetual ~10s supersession loop that
  spammed every mesh session with `Peer online` events. Now a shared per-agentId
  `owner.pid` (`pid:birthMs`) lets a younger duplicate yield **permanently** to a
  live older sibling. Discriminator is AGE, not liveness: the aby-tarafo mid-
  session-restart survivor is always the older process, so it always revives and
  never wrongly yields (a liveness-only rule raced and broke tarafo — caught by
  the two-process revive test in `tests/suwawo-two-process.mjs`).

## [0.2.0] - 2026-07-19

Sonnette packaged for distribution through the batterie marketplace (aby-zufefu).

### Added
- `sonnette/conductor-channel.js` — committed single-file bundle (`npm run
  build:sonnette`, bun 1.3.14). The batterie assembler vendors source without
  node_modules; the bundle makes the shipped plugin self-contained.
- `sonnette/run.sh` — bun-locating launcher. Searches PATH + well-known install
  dirs and fails loud on stderr when bun is absent (MCP servers fail soft, so a
  bare `command: "bun"` would ENOENT silently on a bunless machine).
- CI job `sonnette-bundle-fresh` — rebuilds the bundle (pinned bun) and diffs,
  so a src/ edit without a rebuild goes red instead of shipping stale.

### Changed
- plugin.json mcpServers now runs the wrapper + bundle instead of
  `bun src/conductor-channel.ts` (dev hot path via .mcp.json is unchanged).

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
