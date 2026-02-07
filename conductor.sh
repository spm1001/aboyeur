#!/bin/bash
#
# Aboyeur — the one who calls.
#
# Alternates worker and reflector sessions. Pages the human when stuck.
#
# Usage: conductor.sh [options] <project_dir>
#
# Options:
#   --adapter <pi|claude-code>   Agent harness to use (default: pi)
#   --max-idle <minutes>         Page human if no arc progress after N minutes (default: 60)
#   --pager <path>               Pager script (default: adapters/pager/notify.sh)
#
# The conductor is deliberately simple. The intelligence lives in:
#   - shared/prompts/worker-open.md (what workers do)
#   - shared/prompts/reflector-open.md (what reflectors do)
#   - the handoff files on disk (the protocol between sessions)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Defaults ────────────────────────────────────────────────────────────

ADAPTER="pi"
MAX_IDLE_MINUTES=60
PAGER="$SCRIPT_DIR/adapters/pager/notify.sh"

# ─── Parse args ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
    case "$1" in
        --adapter)
            ADAPTER="$2"
            shift 2
            ;;
        --max-idle)
            MAX_IDLE_MINUTES="$2"
            shift 2
            ;;
        --pager)
            PAGER="$2"
            shift 2
            ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            PROJECT_DIR="$1"
            shift
            ;;
    esac
done

PROJECT_DIR="${PROJECT_DIR:?Usage: conductor.sh [options] <project_dir>}"
PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"  # resolve to absolute

ADAPTER_SCRIPT="$SCRIPT_DIR/adapters/${ADAPTER}.sh"
if [ ! -x "$ADAPTER_SCRIPT" ]; then
    echo "Adapter not found or not executable: $ADAPTER_SCRIPT" >&2
    exit 1
fi

if [ ! -x "$PAGER" ]; then
    echo "Pager not found or not executable: $PAGER" >&2
    exit 1
fi

# ─── State ───────────────────────────────────────────────────────────────

ROLE="worker"  # start with a worker
CYCLE=0
LAST_ARC_HASH=""
LAST_PROGRESS_TIME=$(date +%s)
LOG_FILE="$PROJECT_DIR/.aboyeur/conductor.log"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg" | tee -a "$LOG_FILE"
}

# ─── Arc state snapshot ──────────────────────────────────────────────────

arc_hash() {
    # Hash of arc state — if this changes, progress was made
    if [ -d "$PROJECT_DIR/.arc" ]; then
        (cd "$PROJECT_DIR" && arc list --all --json 2>/dev/null | shasum -a 256 | cut -d' ' -f1) || echo "no-arc"
    else
        echo "no-arc"
    fi
}

check_stuck() {
    local current_hash
    current_hash=$(arc_hash)

    if [ "$current_hash" != "$LAST_ARC_HASH" ]; then
        # Progress was made
        LAST_ARC_HASH="$current_hash"
        LAST_PROGRESS_TIME=$(date +%s)
        return 1  # not stuck
    fi

    local now
    now=$(date +%s)
    local elapsed_minutes=$(( (now - LAST_PROGRESS_TIME) / 60 ))

    if [ "$elapsed_minutes" -ge "$MAX_IDLE_MINUTES" ]; then
        return 0  # stuck
    fi

    return 1  # not stuck yet
}

# ─── Handoff check ──────────────────────────────────────────────────────

latest_handoff_has_escalation() {
    # Check if the most recent handoff contains HUMAN REVIEW NEEDED
    local encoded_path
    encoded_path=$(echo "$PROJECT_DIR" | tr '/.' '-')
    local handoff_dir="$HOME/.claude/handoffs/$encoded_path"

    if [ ! -d "$handoff_dir" ]; then
        return 1
    fi

    local latest
    latest=$(ls -t "$handoff_dir"/*.md 2>/dev/null | head -1)

    if [ -z "$latest" ]; then
        return 1
    fi

    grep -qi "HUMAN REVIEW NEEDED" "$latest" 2>/dev/null
}

# ─── Main loop ───────────────────────────────────────────────────────────

LAST_ARC_HASH=$(arc_hash)

log "Aboyeur starting. Project: $PROJECT_DIR, Adapter: $ADAPTER"
log "Max idle: ${MAX_IDLE_MINUTES}m. Pager: $PAGER"

while true; do
    CYCLE=$((CYCLE + 1))
    log "Cycle $CYCLE: starting $ROLE session"

    # Run the session
    "$ADAPTER_SCRIPT" "$ROLE" "$PROJECT_DIR"
    EXIT_CODE=$?

    log "Cycle $CYCLE: $ROLE session exited (code $EXIT_CODE)"

    # Check for escalation in handoff
    if latest_handoff_has_escalation; then
        log "ESCALATION: handoff contains HUMAN REVIEW NEEDED"
        "$PAGER" "Aboyeur" "Human review needed — check latest handoff in $PROJECT_DIR"
        log "Paged human. Waiting for input..."
        echo ""
        echo "═══════════════════════════════════════════════════════"
        echo " HUMAN REVIEW NEEDED"
        echo " Check the latest handoff, then press Enter to continue"
        echo " or Ctrl+C to stop."
        echo "═══════════════════════════════════════════════════════"
        echo ""
        read -r
        log "Human acknowledged. Resuming."
        LAST_PROGRESS_TIME=$(date +%s)
    fi

    # Check if stuck (no arc progress for too long)
    if check_stuck; then
        log "STUCK: no arc progress for ${MAX_IDLE_MINUTES}+ minutes"
        "$PAGER" "Aboyeur" "No progress for ${MAX_IDLE_MINUTES}m in $PROJECT_DIR"
        echo ""
        echo "═══════════════════════════════════════════════════════"
        echo " NO PROGRESS DETECTED"
        echo " Arc state hasn't changed in ${MAX_IDLE_MINUTES} minutes."
        echo " Press Enter to continue or Ctrl+C to stop."
        echo "═══════════════════════════════════════════════════════"
        echo ""
        read -r
        log "Human acknowledged. Resetting idle timer."
        LAST_PROGRESS_TIME=$(date +%s)
    fi

    # Alternate roles
    if [ "$ROLE" = "worker" ]; then
        ROLE="reflector"
    else
        ROLE="worker"
    fi
done
