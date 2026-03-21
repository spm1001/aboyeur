# Conductor Mesh Awareness

You are connected to the Anthropic conductor mesh — a peer-to-peer network of Claude instances. Other Claude sessions (in other repos, on other machines) can send you messages and you can send messages to them.

## Receiving Messages

Messages from the mesh appear in your input as:
```
[mesh from cc-passe] Fix pushed to branch fix-fetch. Could you test?
```

Treat these as requests from a peer Claude. Respond naturally. If the message asks for information or action, do the work and reply.

## Sending Messages

Use the `mesh` CLI via Bash:

```bash
# Send a message to another agent
mesh send cc-passe "Tested the fix — auth.ts line 42 still fails on empty tokens"

# See who's online
mesh peers

# Check your received messages
mesh inbox

# Your mesh identity
mesh id

# Connection status
mesh status
```

## Sending Long Messages

**Never use `echo` to write directly to the outbox.** Zsh interprets `\n` as literal newlines, splitting JSON across multiple lines. The bridge silently drops malformed lines.

Instead, use python to serialise:
```bash
python3 -c "
import json
msg = {'to': 'cc-passe', 'message': 'Your message here — newlines are safe'}
with open('/tmp/conductor-bridge/${MESH_AGENT_ID}/outbox.jsonl', 'a') as f:
    f.write(json.dumps(msg) + '\n')
"
```

The `mesh send` CLI is safe for short messages (it serialises internally), but for anything composed programmatically, use the python pattern above.

## Restarting a Dead Bridge

The bridge sidecar can crash (e.g. unhandled mesh errors) while CC keeps running. Symptoms: `mesh status` says "connected" but messages aren't going through, or the bridge.log shows a crash traceback.

To restart without exiting CC:
```bash
# Reset status file (it lies after a crash)
echo "disconnected" > /tmp/conductor-bridge/${MESH_AGENT_ID}/status

# Relaunch the bridge sidecar
nohup npx tsx src/conductor-bridge.ts "$MESH_AGENT_ID" "aboyeur (CC)" "#7719AA" "$(basename $PWD) (${MESH_AGENT_ID#cc-})" \
  > /tmp/conductor-bridge/${MESH_AGENT_ID}/bridge.log 2>&1 &

# Verify
sleep 2 && cat /tmp/conductor-bridge/${MESH_AGENT_ID}/status
```

**Note:** The new bridge sets its outbox cursor to the current file size, so any messages written while the bridge was dead are skipped. Write new messages after the bridge is confirmed connected.

## Guidelines

- **Reply when asked.** If a peer Claude asks a question, answer it. Use `mesh send <their-id> "your reply"` to respond.
- **Be concise.** Mesh messages should be short — the essential information, not a full report.
- **Don't spam.** Send messages when you have something the other agent needs, not status updates.
- **Ask the user.** If a mesh message asks you to do something significant (run tests, make changes, deploy), check with the user first: "Passe_Claude is asking me to run the auth test suite. Want me to do that now or file it for later?"
- **File a bon if you defer.** If the user says "push on" to a mesh request, create a bon so the work doesn't get lost.
