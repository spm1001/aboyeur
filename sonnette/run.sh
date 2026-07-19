#!/bin/bash
# sonnette launcher — locate bun, exec the bundled conductor-channel server.
#
# Why this exists: MCP servers fail SOFT. If plugin.json said `command: "bun"`
# and bun weren't on the CC process's PATH, the spawn would ENOENT silently and
# the session would simply lack mesh tools — no error anywhere (the landmine
# found 2026-07-14). This wrapper searches the well-known install locations and
# fails LOUD on stderr (visible in MCP logs) when bun is genuinely absent.
#
# Usage: run.sh <path-to-bundle.js>
# The bundle path arrives as $1 (not derived from $0) so the batterie
# assembler's MCP entry-point guard existence-checks the bundle too.

BUNDLE="$1"
if [ -z "$BUNDLE" ] || [ ! -f "$BUNDLE" ]; then
  echo "sonnette: bundle not found: '$BUNDLE' — broken plugin package" >&2
  exit 1
fi

if command -v bun >/dev/null 2>&1; then
  exec bun "$BUNDLE"
fi
for candidate in "$HOME/.bun/bin/bun" "$HOME/.local/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
  if [ -x "$candidate" ]; then
    exec "$candidate" "$BUNDLE"
  fi
done

echo "sonnette: bun not found on PATH or in ~/.bun/bin, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin." >&2
echo "sonnette: install bun (https://bun.sh) to enable conductor mesh connectivity. Mesh unavailable this session." >&2
exit 1
