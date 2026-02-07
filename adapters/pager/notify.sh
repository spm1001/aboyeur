#!/bin/bash
#
# Pager — macOS notification.
#
# Usage: notify.sh <title> <message>
#

TITLE="${1:?Usage: notify.sh <title> <message>}"
MESSAGE="${2:?Usage: notify.sh <title> <message>}"

osascript -e "display notification \"$MESSAGE\" with title \"$TITLE\" sound name \"Glass\""

# Also log to stderr so conductor output captures it
echo "[pager] $TITLE: $MESSAGE" >&2
