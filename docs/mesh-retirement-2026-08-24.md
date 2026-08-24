# The mesh retirement — where every capability went

**Date:** 2026-08-24 · **Board:** `aby-dunudo` (the direction, filed 2026-08-09), `aby-dovupi` (the strip), `son-pilalu` (the marketplace delisting), `aby-nedora` (the roadmap adjudication)

Sonnette — the WebSocket bridge to Anthropic's conductor mesh, shipped as a plugin in the public `batterie` marketplace — is retired. This is the record `aby-dunudo` asked for: what each capability did, and where it went.

## What was removed

Delisted from the marketplace in `spm1001/batterie@87def57` (out of the `PLUGINS` map, out of `marketplace.json`, `plugins/sonnette/` deleted), uninstalled on tube and the Mac, and the code deleted from this repo in `4f41e80` — `conductor-bridge.ts`, `conductor-channel.ts`, `mesh-capability.ts`, `mesh-id.ts` and their tests, the committed `sonnette/` bundle and wrapper, `.mcp.json`, the mesh harness, `tools/legacy`, and the `sonnette-bundle-fresh` CI guard. Twenty files. `git show 4f41e80^` has all of it.

## Where each capability went

| Capability | Successor | Notes |
|---|---|---|
| Peer-to-peer messaging, one machine | **sonner** (`spm1001/sonner`) and CC-native `SendMessage` | sonner addresses a *repo*, not a session id, and spawns one if nobody's home. No launch flag, no trust dialog. |
| Seeing who is running | `sonner --list` | Unions socket dirs and every config dir's session records. |
| Waking a session elsewhere | `sonner --wake <repo>` | Replaces `/consult`'s wake half, which never needed the mesh anyway (proven 2026-07-19). |
| One-shot "phone a friend" (`/consult`) | `sonner --wake` + a ring | The skill itself was mesh-only by construction and is dormant (`skillOverrides: consult: off`). |
| Honest delivery reporting | sonner, natively | `aby-nowabu`'s delivery-truth principle survived the transport: don't mint "sent" over an error the client already has. |
| **Cross-machine initiation** | **`ssh <host> sonner <repo> '<msg>'`** | See below — this is the one most likely to be misremembered as lost. |
| Office-Claude interop | **None. Dropped knowingly.** | Parked as "welcome later" months before; retiring drops it deliberately, not by oversight. |

## The cross-machine correction, because it was got wrong once already

sonner discovers peers over unix sockets, so it is machine-local *in discovery*. That is easy to over-read as "cross-machine peer messaging is gone", and on 2026-08-24 a session did exactly that — took the line in sonner's own `peer-messaging` skill ("its cross-machine reach is real and native messaging does not replace it") at face value, wrote "nothing replaces it" into four files, and put the question to Sameer as an accepted capability loss.

**It is not lost.** You reach another host by running sonner *there*:

```bash
ssh <host> sonner <repo> '<message>'
```

Demonstrated tube→Mac into a live session on 2026-08-09 (`aby-dunudo`), and the invocation path re-verified on 2026-08-24: tube runs `sonner --list` on the Mac over non-interactive ssh cleanly. What genuinely changed is that the estate no longer has *ambient* cross-machine presence — you cannot see a remote peer in a local `--list`, and you must know which host to reach. That is a real narrowing, and a much smaller one than "gone".

The lesson is the ordinary one: a brief's named mechanism is a hypothesis until re-derived, and the skill's line was written before the ssh route was demonstrated. `aby-dunudo` recorded the successor on the day; the session that missed it had read the board through `bon list | head -40` and never saw the item.

## What was kept, and why

- **`docs/MESH-SETUP.md`** — historical, with a header saying so. Its delivery-semantics measurements explain why the honesty bar for the successor was set where it was.
- **`docs/CONDUCTOR-PROTOCOL.md`, `docs/native-xsm-review-2026-08-08.md`, the friction log, the future sketch** — records of thinking, not instructions.
- **`conductor.sh`** — never mesh code at all. It is the worker/reflector loop this repo is named for. It was deleted by mistake in `4f41e80` on the `conductor.sh` / `conductor-channel.ts` name collision and restored in `47f7596`. **That shared word is the tripwire for anyone pruning here: the *channel* is the mesh, the *shell script* is the orchestrator.**
- **`MESH_DISABLED=1`**, still set unconditionally by `spawnAgent()`. Nothing reads it here now, but an older conductor-channel could still exist somewhere on the estate and a spawned session inheriting a live one would mint an unwanted identity.

## The idea worth carrying out

From `aby-sahifi`, which never shipped: **the fault is not that send-only sessions exist — it is that they are indistinguishable from absent ones.** Written for the mesh's deaf-peer trap, where two handoff messages were lost on 2026-07-26 to a session advertising a receive capability it did not have.

It is now sonner's problem, and worse there by measurement: the 2026-08-09 census found five of eight live sessions on tube deaf — provider-billed, full registry record, no `messagingSocketPath`. The invisible class is the majority, not an edge. Carried into `son-nukuzi` with the surface mapping; sonner already has the send-time refusal via `son-fomuno` and needs the roster annotation.
