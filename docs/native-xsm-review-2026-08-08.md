# Native cross-session messaging (CC ≥2.1.224) — live review on tube, 2026-08-08

Working findings log for: can Claude Code's built-in `ListAgents`/`SendMessage` + inbox sockets replace or simplify Sonnette, and what does it change for aboyeur? Doc: https://code.claude.com/docs/en/cross-session-messaging.md — tube runs CC 2.1.226, feature live with nothing to enable.

## How it works (from the doc, confirmed live where noted)

- Every session with the feature binds a per-user Unix socket in `/run/user/1000/cc-socks/<pid>.sock` and registers itself on disk. Same-machine delivery is socket-to-socket, never via Anthropic servers. **Confirmed live.**
- Two tools: `ListAgents` (discovery) and `SendMessage` (delivery by name). The `/list-agents` (aka `/peers`) command shows the human view; `/status` shows a session's own `Peer address`.
- Inbound control is per-receiver: `crossSessionInbound` = accept / hold / refuse. With no explicit setting, delivery depends on permission-mode **class matching**: bypass-class senders deliver to bypass-class receivers, prompting-class to prompting-class; cross-class messages are **held** for human approval (5-min default expiry, then dropped).
- Sender gets truthful outcomes: delivered / held / denied notices, same-machine. **Confirmed live** — msg_id on success, and a bare-name send is refused with a disambiguation notice requiring the `name [ref]` form.
- Receiving Claude reads messages **between tool calls mid-turn** (never interrupting a running tool) or as a fresh turn when idle. **Mid-turn arrival confirmed live** in this session.
- Cross-machine (via Remote Control / web): **reply-only** — a tube session cannot open a conversation with a Mac session, only answer one that messaged it first. Travels via Anthropic servers.
- Guardrails injected on receipt: a peer message can't approve permission prompts, can't change config, slash commands in it don't execute, and permission laundering is explicitly refused. **Confirmed live** — the wrapper text arrived with the test message.
- Anti-loop: per-sender rate limiting, identical-repeat dropping within a short window, 50-message cap per session. (Heartbeat designs with fixed text will silently lose messages — test below.)
- `claude -p` sessions bind sockets too (receive + appear in listings); **bare mode** doesn't. A `-p` session can't show the approval dialog, so held messages there die silently — unattended workers need `crossSessionInbound: accept` in `--settings`.
- Scripts/hooks can post into a session's socket directly (`CLAUDE_CODE_MESSAGING_SOCKET`, exported to Bash and hooks). Own-child posts are verified and delivered (Linux: even after the child exits). Foreign-script posts assert no class → held by bypass-class receivers.

## Live findings (tube, 2026-08-08 night)

1. **Environment**: CC 2.1.226; this infra session (cloud/sdk-driven, `--print --sdk-url`) has a live socket and both tools. No feature-flag blockers. No `crossSessionInbound`/`isolatePeerMachines` set anywhere in settings.
2. **Prompting→prompting delivers**: a default-mode `claude -p` peer found this session via ListAgents (name `infra-92 [b4cd9f]`), was refused on the bare name, re-sent with ref, got `success:true` + msg_id — and the message arrived here mid-turn with full provenance (from-name, from-mode, uds address).
3. **ListAgents (the tool) shows name/ref/kind/age but NOT working directory** — the cwd column exists only in the human `/list-agents` command. Address matching must ride on names, so `--name` discipline matters for orchestration.
4. **This cloud-driven session counts as prompting-class** — empirically determined (the prompting peer delivered; per the class rules a bypass peer's message would have been held).
5. **A `--dangerously-skip-permissions` `-p` spawn hit a Fable 5 safety-filter API error on its prompt** (before any messaging) — unrelated to the feature; noting because orchestration scripts that spawn workers must handle model-refusal exits.

6. **Round trip mid-task works, unattended.** A `claude -p --name worker-slow --settings '{"crossSessionInbound":"accept"}'` worker looping `sleep 15` × 6 received my message **between tool calls** (after sleep 2), replied with `SendMessage` addressed to my raw `uds:` path, and resumed its loop. Its own final tally confirmed both directions. This is the aboyeur worker primitive, working, with no plugin, no bundle, no bun, no flag.

7. **⚠️ IDENTICAL-TEXT MESSAGES ARE SILENTLY DROPPED — the single most important finding.** I sent the worker four sends of the exact text `XSM-HEARTBEAT tick` within ~90 s. **All four returned `success:true` with four distinct `msg_id`s.** The worker received **one**. Its verbatim tally: two messages total (the M1 test + one tick), and "no further messages arrived during sleeps 4–6". So the sender was told success four times for one delivery. This is *precisely* Sonnette's `aby-nowabu` trap — "delivered" that isn't — reintroduced natively by a different door. Any fixed-text heartbeat or "still alive" ping design dies here. (n=1; control with varied text below.)

8. **No dead-peer ghosts, and the error is honest.** After the worker exited, `ListAgents` → `No reachable agents.` immediately, and a send to it → `{"success":false,"message":"No agent named 'worker-slow [88ceaa]' is reachable."}`. Compare Sonnette's 60–120 s roster expiry window and its *permanent* replay-gap ghosts. Native discovery is filesystem/socket truth, not a server-replayed roster.

9. **Addressing is name-based and collision-guarded.** A bare-name send is *refused* with a disambiguation notice naming the exact `name [ref]` to retry with — a refusal, never a silent misdelivery. Note the asymmetry: the *listing* gives `name [ref]`, but an *inbound* message's `from` is the raw `uds:` socket path, so a replying peer addresses a path, not a name. Names and reply addresses are two different namespaces.

10. **The socket wire format is trivial and script-postable.** Captured with a `socat` decoy socket in `cc-socks/` (a real `SendMessage` to `uds:.../decoy.sock` succeeded and dumped its bytes) — one line of JSON, newline-terminated:

    ```json
    {"msgV":1,"msg_id":"<uuid>","type":"user",
     "message":{"role":"user","content":"<cross-session-message from=\"uds:/run/user/1000/cc-socks/954309.sock\" from-mode=\"prompting\">\nBODY\n</cross-session-message>"},
     "priority":"next","from":"uds:/run/user/1000/cc-socks/954309.sock"}
    ```

11. **A FOREIGN systemd unit can ring a live session. Confirmed.** `systemd-run --user --collect` (a transient unit, *not* a child of the receiving session) piping that JSON into `socat - UNIX-CONNECT:$SOCKET` **delivered** to this session. Also confirmed: an own-child `socat` post from a plain Bash tool call delivered. The doc's caveat applies — my session is prompting-class, so nothing was held; a bypass-class receiver would hold a foreign post for approval, since it asserts no permission class.

12. **`from` is forgeable; the harness knows it.** From the binary's own schema description: `verifiedPeerPid` is "Kernel-verified pid of the process that connected … read from the connection (SO_PEERCRED / LOCAL_PEERPID) — never from the payload … Key sender identity on this, never on `from`: `from` is sender-authored and kept only for reply routing, so it is forgeable by any same-user process." I demonstrated exactly this — my foreign post claimed `from: script:foreign-unit` and `from-name: systemd-unit-test`, both accepted verbatim. Same-user trust boundary only.

13. **Relay-loop machinery is built in.** The envelope regex in the binary parses `from`, `from-session`, `hop-chain`, `from-name`, `from-mode`. A `hop-chain` attribute means Anthropic anticipated relayed/forwarded traffic — relevant if aboyeur ever wants a cross-machine bridge.

14. **A `--dangerously-skip-permissions` `-p` spawn hit a Fable 5 safety-filter API error** on its own prompt, before any messaging. Unrelated to the feature, but noted: orchestration scripts that spawn workers must handle model-refusal exits, and the same filter later ended the Fable half of this session (switched to Opus 5 mid-review).

15. **Varied-text control — the dedup finding is confirmed and correctly attributed.** Same worker shape, four *distinct* messages sent in the same rapid burst: **all four delivered**, in order, verbatim. Against four identical texts → one delivered. So the discriminator is **text identity, not rate**. Finding 7 stands as a controlled result, not a one-sample suspicion.

16. **IDLE-WAKE WORKS — this is the conductor primitive.** Drove a real interactive TUI session under tmux via hublot (`claude --name idle-target` in infra-signboard), left it sitting at its prompt with no human typing, and messaged it. It woke on its own, rendered the collapsed `› Message from @peer (ctrl+o to expand)` row, reasoned, and replied via `SendMessage`. Its own account of the mechanics:
    - the message "arrived as a fresh user turn";
    - **the SessionStart hook fired with it** — "Session restarted. Settings and hooks have been reloaded" — so a wake re-runs the session-start ritual (orientation for free; tokens as the cost);
    - **no permission dialog appeared**; first tool calls ran immediately. The only friction was one extra `ToolSearch` round because `SendMessage` is a deferred tool.

17. **`ListAgents` is richer for interactive peers than for `-p` ones.** An interactive row carries live state and location: `idle-target [79cf80] · interactive · idle · tmux hublot-idlewake:@0.%0 · started 14s ago`. So the tool reports **idle/busy** and even the **tmux pane**. (Corrects finding 3, which was taken from `-p` peers only — those show no such detail. A negative read off the thinner surface would have been the instrument's limit, not the feature's.)

18. **Bypass-class hold: NOT TESTED — the probe was invalid.** A `claude -p --dangerously-skip-permissions` peer was spawned twice to test the cross-class hold path. It sent successfully and delivered normally, but its own transcript shows harness guards *still firing on it* (a `sleep` block, and the cross-session send confirmation) — so it was **not actually bypass-class**, and the test never exercised the hold. Likely the Teams-managed account withholds bypass mode. **The approval-dialog path therefore remains unmeasured on this estate** — and possibly unreachable here, which would be a convenience, not a limitation. Do not read "no dialogs seen" as "dialogs never fire".

19. **Fable 5's safeguards flag a `--dangerously-skip-permissions` spawn.** Reproduced twice: the spawned peer died with "Fable 5's safeguards flagged this message". Passing `--model claude-opus-5` got through. Relevant to any orchestrator that spawns workers — model choice is a live dependency of whether a spawn survives.

## sonner — closing the gap native messaging leaves

Native messaging only reaches sessions **already running**. There is no store-and-forward and no spawn-on-demand, so a message to a repo nobody is sitting in is undeliverable. sonner closes that, using only primitives proven above. *(Born here as `tools/sonner.py`; extracted 2026-08-09 to its own repo, `~/repos/spm1001/sonner`, where it lives with the peer-messaging skill — installed on PATH via `uv tool install`.)*

Discovery, which the docs don't spell out but `/proc` gives for free: **the socket filename is the session's pid**, so `readlink /proc/<pid>/cwd` says which repo each live session is in. That is the whole trick — a plain script can route by repo without any Claude Code API.

```
sonner REPO MESSAGE [--from NAME] [--all] [--no-spawn] [--stamp] [--list]
```

Live session in the repo → deliver to its socket. None → start one under tmux, wait for its socket to appear, then deliver the same envelope. **Spawn-then-deliver, never prompt-injection**: passing the text as the new session's prompt would read as *the user* speaking and invite deference, which is exactly the dynamic aboyeur's design exists to avoid. Delivering over the socket keeps peer framing and the harness's peer guardrails.

**Both paths demonstrated end-to-end, 2026-08-08:**

- **Warm repo** (infra-signboard, session idle): `rang pid 959137`. Woke, ACKed back, and reported it was indistinguishable from a Claude-originated message — script provenance and all: `from="script:sonner-demo"`.
- **Cold repo** (infra-openwrt, no session): `no session … — starting one` → `woke pid 961132`. The woken Claude's own description of what it got: *"it arrived as the session's opening USER PROMPT carrying a peer-message envelope — the content sat inside a `<cross-session-message from="script:sonner-demo">` block in the user-turn position, with the standard harness note that it came from another Claude session rather than being typed by my user. So: peer-message framing, user-prompt slot."* The `UserPromptSubmit` and SessionStart hooks both fired.

So **peer framing survives a cold spawn.** That was the open design risk and it came out the right way.

## Open tests

- [x] Me→worker send; worker receives mid-task with `accept` (finding 6)
- [x] Duplicate-text drop — confirmed, silent (finding 7), with varied-text control (finding 15)
- [x] Dead-peer: no ghosts, honest error (finding 8)
- [x] Socket wire format + foreign systemd post (findings 10–12)
- [x] Idle-wake of a real interactive TUI session (finding 16)
- [x] Wake-a-repo-with-no-Claude — built and demonstrated (sonner, above)
- [ ] **Bypass→prompting hold + sender-side notices — attempted, probe invalid** (finding 18)
- [ ] Cross-machine reply path (needs a Mac or web session in the listing)
- [ ] Does the dedup window have a duration? Measure when an identical text becomes deliverable again.

## Verdict

**Native messaging replaces Sonnette's transport, and deletes the whole category of cost that came with owning one.** Gone: the vendored 0.5 MB bundle and its CI drift guard, the bun-on-PATH fleet rule with its silent ENOENT, `/proc`-based capability inference, supersession wars between duplicate servers, `/tmp` debug residue shipping to strangers, and — the big one — `aby-lesefu`, the managed-settings allowlist that is **blocked on Anthropic and cannot be unblocked locally**. Native needs no allowlist, no flag, no plugin, no trust dialog.

It is also *better* on the axes where Sonnette actually bled: no roster ghosts, honest unreachable errors, refusal-on-ambiguity rather than silent misdelivery, and inbound that genuinely works in `-p`, on resume, and in interactive sessions alike — no birth-flag, no retrofit problem.

**Three things it does not do**, and only the first is structural:

1. **Cross-machine is reply-only.** Sonnette's account-keyed conductor room let tube and the Mac talk with zero networking; per-session Unix sockets are same-machine by definition. Tube cannot open a conversation with a Mac session. This is the one genuine capability loss and the reason not to delete Sonnette outright yet.
2. **No offline queue.** Neither had one. Aboyeur's existing answer stands and is better than a queue: **bons are the inbox**, and the wake carries ids and counts, never source text ("doorbell not payload").
3. **No broadcast or topics.** Loop over `ListAgents`; the identical-text dedup means a broadcast must vary its text per recipient or most copies vanish silently.

**The trap to carry forward:** `success: true` with a fresh `msg_id` is *not* arrival when the text repeats. This is Sonnette's `aby-nowabu` lesson arriving through a new door, and it is the single most likely way this bites us later.

## What we did about it — three tiers, not one document

Reviewing the traffic produced three different kinds of residue, and each wanted a different home. Writing all of it as prose would have been the lazy answer.

**Enforced in code.** `sonner` now stamps every message by default (`--no-stamp` opts out). A hazard invisible from both ends is the wrong thing to protect against opt-in. Verified: two identical invocations 104 ms apart both delivered, where unstamped they would have collapsed to one.

**Filed for the moment-of-action tier.** `carte-cutuga` on the `~/.claude` board. The duplicate-drop has an *observable trigger* — a `SendMessage` whose text matches a recent one — so by the three-tier rule it argues for a gouteur render at the send rather than a prose row. Prose is the fallback if the render cannot see prior sends.

**Written down as habits.** `~/.claude/skills/peer-messaging/` — the residue that no gate can catch: what to put in a message, when a wake earns its cost against just filing a board item, how to answer at machine register, and who holds the next move. Grounded in what four sessions actually did on 2026-08-08 rather than in what sounds sensible.

Observed habits worth their place, all from tonight's traffic: four of four sessions burned a round trip on the bare-name address; two woken sessions wrote polished human-facing reports to a machine reader; one applied Sonnette's channels-flag lore to a transport with no such concept and attached a confident verdict; and two — correctly — volunteered that they had left the repo's own work untouched.

## Late finding: the session registry beats /proc, and makes sonner portable

A subagent testing the skill reported two things worth verifying directly, and both held.

**`ListAgents` is not provisioned everywhere.** It searched twice and the tool was absent in a subagent context, which removes the listing the addressing rule leans on. It recovered by the route the skill itself names — send the bare name, read the refusal, resend in the form the refusal gives — so the guidance degrades gracefully. Worth knowing that the tool is not a given.

**Every session registers itself at `~/.claude/sessions/<pid>.json`.** Verified by reading one:

```json
{ "pid": 954309, "sessionId": "b4aacb1d-…", "cwd": "/home/modha/repos/spm1001/infra",
  "startedAt": 1786226963824, "procStart": "10472862", "version": "2.1.226",
  "peerProtocol": 1, "kind": "interactive", "entrypoint": "sdk-cli",
  "messagingSocketPath": "/run/user/1000/cc-socks/954309.sock",
  "name": "infra-92", "nameSource": "derived" }
```

This is the "files on disk" the documentation alludes to without naming, and it is strictly better than the `/proc` derivation sonner shipped with. It carries the session's **addressable name**, which `/proc` cannot know; it gives the socket path outright rather than by convention; it includes `procStart`, which guards against pid recycling; and it needs no `/proc` at all — **so the same discovery works on a Mac.**

`sonner` now reads the registry, checks the socket still exists and the pid is still alive (a record can outlive its session), and reports names rather than bare pids:

```
$ sonner --list
repos-91               962571  /home/modha/repos
infra-92               954309  /home/modha/repos/spm1001/infra
```

The `/proc` trick remains a true fact about this estate and is no longer how sonner works.

