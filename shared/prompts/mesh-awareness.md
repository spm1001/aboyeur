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

## Guidelines

- **Reply when asked.** If a peer Claude asks a question, answer it. Use `mesh send <their-id> "your reply"` to respond.
- **Be concise.** Mesh messages should be short — the essential information, not a full report.
- **Don't spam.** Send messages when you have something the other agent needs, not status updates.
- **Ask the user.** If a mesh message asks you to do something significant (run tests, make changes, deploy), check with the user first: "Passe_Claude is asking me to run the auth test suite. Want me to do that now or file it for later?"
- **File a bon if you defer.** If the user says "push on" to a mesh request, create a bon so the work doesn't get lost.
