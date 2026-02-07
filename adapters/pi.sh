#!/bin/bash
#
# Pi adapter — start a Pi session with an initial message and wait for exit.
#
# Usage: pi.sh <role> <project_dir>
#   role: "worker" or "reflector"
#   project_dir: directory to run in
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ABOYEUR_DIR="$(dirname "$SCRIPT_DIR")"

ROLE="${1:?Usage: pi.sh <worker|reflector> <project_dir>}"
PROJECT_DIR="${2:?Usage: pi.sh <worker|reflector> <project_dir>}"

# Select the prompt for this role
case "$ROLE" in
    worker)
        PROMPT_FILE="$ABOYEUR_DIR/shared/prompts/worker-open.md"
        ;;
    reflector)
        PROMPT_FILE="$ABOYEUR_DIR/shared/prompts/reflector-open.md"
        ;;
    *)
        echo "Unknown role: $ROLE (expected worker or reflector)" >&2
        exit 1
        ;;
esac

if [ ! -f "$PROMPT_FILE" ]; then
    echo "Prompt file not found: $PROMPT_FILE" >&2
    exit 1
fi

INITIAL_MESSAGE=$(cat "$PROMPT_FILE")

# Start Pi in the project directory with the initial message
# The session will run interactively — human can observe and intervene
cd "$PROJECT_DIR"
exec pi --initial-message "$INITIAL_MESSAGE"
