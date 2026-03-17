#!/bin/bash
# walkie-hook.sh — hook for local agent messaging
# Checks partner's outbox on PostToolUse and UserPromptSubmit.
# Silent when not in walkie mode.
#
# Env vars:
#   WALKIE_ID       — this agent's identity
#   WALKIE_PARTNER  — partner agent's identity
#
# Output: additionalContext with new messages, or nothing.
# Works for both PostToolUse and UserPromptSubmit hook events.

[ -z "$WALKIE_ID" ] && exit 0
[ -z "$WALKIE_PARTNER" ] && exit 0

# Read stdin (CC passes JSON with hook_event_name) — consume it so it doesn't interfere
STDIN_JSON=$(cat)
EVENT_NAME=$(echo "$STDIN_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('hook_event_name','PostToolUse'))" 2>/dev/null || echo "PostToolUse")

DIR="/tmp/walkie"
INBOX="$DIR/${WALKIE_PARTNER}.jsonl"
CURSOR="$DIR/.cursor-${WALKIE_ID}"

[ -f "$INBOX" ] || exit 0

LAST=$(cat "$CURSOR" 2>/dev/null || echo 0)
SIZE=$(stat -c%s "$INBOX" 2>/dev/null || stat -f%z "$INBOX" 2>/dev/null || echo 0)
[ "$SIZE" -le "$LAST" ] && exit 0

# New messages — read them
MESSAGES=""
while IFS= read -r line; do
    [ -z "$line" ] && continue
    # Extract fields without python for speed (~1ms vs ~30ms)
    FROM=$(echo "$line" | sed -n 's/.*"from" *: *"\([^"]*\)".*/\1/p')
    MSG=$(echo "$line" | sed -n 's/.*"message" *: *"\([^"]*\)".*/\1/p')
    if [ -n "$MSG" ]; then
        MESSAGES="${MESSAGES}📻 [${FROM:-?}] ${MSG}\\n"
    fi
done < <(tail -c +$((LAST + 1)) "$INBOX")

# Update cursor
echo "$SIZE" > "$CURSOR"

[ -z "$MESSAGES" ] && exit 0

# Inject as context — Claude sees this on the current tool call or prompt.
# hookEventName is REQUIRED — without it CC silently drops additionalContext.
cat <<EOF
{"hookSpecificOutput": {"hookEventName": "${EVENT_NAME}", "additionalContext": "${MESSAGES}Walkie message from partner. Read and acknowledge, then continue your work. Reply with: walkie send \"your response\""}}
EOF
