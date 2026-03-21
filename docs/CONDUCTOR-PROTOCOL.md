# Conductor Protocol — Formal Documentation

**Date:** 2026-03-14
**Source:** Live observation via CDP on `pivot.claude.ai`, bundle analysis of `index-CpkOgGMM.js`
**Gate:** `pivot-hive` (GrowthBook)

This document formally describes the conductor peer mesh protocol — how Claude instances running in separate Office add-in panes discover each other, exchange messages, share files, and self-organise. Based on wire-level captures, a 1,291-line rich trace of a live 6+ agent session, extracted system prompts, and bundle code analysis.

---

## 1. Architecture Overview

The conductor is a **WebSocket-relayed peer mesh** connecting Claude instances across Office apps (Excel, PowerPoint, Word). Each instance is an independent Claude conversation with its own context window. The conductor protocol lets them:

- **Discover** each other via registration and `get_connected_agents`
- **Message** each other via `send_message` (serial or fire-and-forget)
- **Share files** via `conductor.writeFile()` (broadcast to all peers)
- **Read transcripts** via the virtual filesystem (`/agents/<id>/transcript.jsonl`)

The relay runs through `pivot.claude.ai` — there is no direct peer-to-peer connection. The WebSocket endpoint is `wss://bridge.claudeusercontent.com/v2/conductor/{profile.uuid}`.

### Transport

**Two distinct WebSocket endpoints on `bridge.claudeusercontent.com` (discovered 21 Mar 2026):**

| Endpoint | Protocol | Purpose |
|----------|----------|---------|
| `/v2/conductor/{uuid}` | Conductor mesh | Multi-agent peer-to-peer. `register` → `conductor_connected` → events. Used by aboyeur bridge. |
| `/office/{uuid}` | Cowork / Remote Control | Desktop ↔ add-in pairing. `connect` → `available_addins` → `paired` → `addin_ready`. Used by Claude Desktop ↔ Mobile (Cowork). |

The Office add-in connects to BOTH: `/office/` for Cowork pairing (via `bridgeConnect()`), and `/v2/conductor/` for the conductor mesh (via the conductor module). These are separate connections with different protocols. Calling `bridgeConnect()` manually does NOT activate the conductor.

**Cowork pairing connect frame (from `/office/` endpoint):**
```json
→ SENT: {"type": "connect", "oauth_token": "...", "account_uuid": "...", "client_type": "addin", "app": "excel", "device_id": "...", "platform": "OfficeOnline", "browser": "chrome"}
← RECV: {"type": "waiting", "user_id": "..."}
← RECV: {"type": "stats", "desktopConnected": false, "addinCount": 1}
```

| Additional Endpoint | Purpose |
|----------|---------|
| `pivot.claude.ai/v1/metrics` | Telemetry (HTTP 200) |
| `pivot.claude.ai/api/analytics` | Analytics events (HTTP 200) |
| `pivot.claude.ai/v1/traces` | OpenTelemetry collection (HTTP 501 — disabled/misconfigured) |
| `api.anthropic.com/v1/messages` | Claude API calls (each agent calls independently) |

---

## 2. Wire Protocol

Five message types observed on the WebSocket:

### 2.1 Heartbeat

```json
→ SENT: {"type":"ping"}
← RECV: {"type":"pong"}
```

Heartbeat is visibility-aware — pauses when the browser tab is hidden. Pong staleness threshold: **90 seconds**. Sleep/wake detection logs timer gaps:

```
[conductor] Timer gap: 68s (expected 30s) — probable sleep/wake
```

### 2.2 Outbound Message (`conductor_send_message`)

Agent sends a message to a specific peer:

```json
→ SENT: {
  "type": "conductor_send_message",
  "to": "excel-89b26a",
  "message": "bootstrap",
  "_agent_id": "powerpoint-c779e4"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"conductor_send_message"` |
| `to` | string | Target agent ID |
| `message` | string | Message text (natural language) |
| `_agent_id` | string | Sender's own agent ID |

### 2.3 Inbound Message (`conductor_message`)

Server delivers a peer's message:

```json
← RECV: {
  "type": "conductor_message",
  "from": "excel-89b26a",
  "message": "Bootstrap complete. 4 standard JSON files are already in my shared files...",
  "_for_agent_id": "powerpoint-c779e4"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"conductor_message"` |
| `from` | string | Sending agent ID |
| `message` | string | Message text |
| `_for_agent_id` | string | Intended recipient agent ID |

### 2.4 Lifecycle and Stream Events (`conductor_event`)

Server broadcasts lifecycle and transcript sync events:

**Stream event** (transcript sync):
```json
← RECV: {
  "type": "conductor_event",
  "event_type": "stream",
  "agent_id": "excel-788108",
  "seq": 7,
  "timestamp": 1773482410126,
  "payload": {
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "Thanks for the status update..."},
          {"type": "text", "text": "<user_context>\nCurrent active sheet: ..."}
        ]
      }
    ]
  }
}
```

**Disconnect event**:
```json
← RECV: {
  "type": "conductor_event",
  "event_type": "disconnect",
  "agent_id": "powerpoint-c779e4",
  "timestamp": 1773483039357,
  "payload": {},
  "replay": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"conductor_event"` |
| `event_type` | string | `"stream"` or `"disconnect"` |
| `agent_id` | string | Agent the event is about |
| `seq` | number | Sequence number (stream events) |
| `timestamp` | number | Unix milliseconds |
| `payload` | object | Event-specific data |
| `replay` | boolean | Whether this is a replayed historical event |

Stream event payloads use the Claude API message format: `role` ("user" or "assistant") with `content` as an array of typed blocks. User messages include `<user_context>` XML as a separate text block.

### 2.5 Outbound Stream (`stream`)

The agent's own conversation messages are broadcast to peers:

```json
→ SENT: {
  "type": "stream",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Nice — fully bootstrapped with ITV context..."},
        {"type": "text", "text": "<user_context>\n{\"selectedSlides\": [...]}"}
      ]
    }
  ]
}
```

This is how other agents can read this agent's transcript — stream events flow through the relay and populate `/agents/<id>/transcript.jsonl` on every peer's virtual filesystem.

---

## 3. Agent Identity

### ID Format

`{surface}-{hex6}` — deterministic, assigned at registration.

| Agent ID | Surface | Document | Role |
|----------|---------|----------|------|
| `excel-89b26a` | Excel (desktop) | Library Claude.xlsx | **The Librarian** — persistent memory layer |
| `powerpoint-b48577` | PowerPoint (web) | Presentation Claude.pptx | **Coordinator** — main ITV deck, 17 slides |
| `powerpoint-c779e4` | PowerPoint (web) | Presentation 2.pptx | **Prototyper** — scratch deck for template building |
| `powerpoint-95dcd0` | PowerPoint (web) | Next Steps in Outcomes.pptx | **Analyst** — FTVA deck reader (22 slides) |
| `powerpoint-8c55a9` | PowerPoint (web) | HbbTV's Time to Shine.pptx | **Analyst** — HbbTV deck reader (17 slides) |
| `excel-788108` | Excel (web) | Book 2.xlsx | **Data & Research Support** (role assigned by Librarian) |
| `excel-99389a` | Excel (web) | (unknown) | Observed online, no traced activity |
| `powerpoint-4dab94` | PowerPoint (web) | (unknown) | Late joiner, observed online only |

The hex suffix persists for the lifetime of the add-in instance but NOT across page reloads.

### Registration Schema

Each agent registers via `Pze()` which broadcasts a schema to all peers:

```json
{
  "instructions": "I am a fully autonomous PowerPoint agent...",
  "appName": "powerpoint",
  "version": "<protocol version>",
  "interface": "powerpoint",
  "capabilities": {
    "receive_message": {},
    "file_sharing": {
      "accept": ["json", "xml", "txt", "md", "svg"]
    }
  },
  "display": {
    "label": "powerpoint",
    "color": "#B7472A"
  }
}
```

### Per-Surface Configuration

| Surface | Label | Color | Accepted Formats | Self-Description |
|---------|-------|-------|-----------------|------------------|
| Excel | `excel` | `#217346` | csv, tsv, json, xml, txt, md | "Fully autonomous — read/write cells, charts, formulas, pivot tables" |
| PowerPoint | `powerpoint` | `#B7472A` | json, xml, txt, md, svg | "Fully autonomous — slides, text, formatting, themes, charts" |
| Word | `word` | `#2B579A` | txt, md, html, json, xml | "Fully autonomous — content, formatting, sections, styles" |
| Default | (surface) | `#7719AA` | (per surface) | "Fully autonomous agent" |

Note: Excel accepts csv but NOT xlsx — the browser sandbox can't unzip OOXML containers. This is explicitly called out in the prompt.

---

## 4. Lifecycle

### 4.1 Connection Sequence

Observed in console logs:

```
[agentRegistry] Agent registered
[conductor] Conductor connected Object
[conductor] Conductor replay complete Object
```

1. **Register** — Agent announces itself with surface, capabilities, display info
2. **Connect** — WebSocket connection established to relay
3. **Replay** — Server replays buffered events from already-connected agents (stream events, file broadcasts). The `replay: true` flag distinguishes replayed from live events.

### 4.2 Peer Discovery

Agents discover each other through three mechanisms:

1. **Stream events** — `conductor_event` with `event_type: "stream"` arrives when any agent produces output
2. **Online notifications** — `🟢 ONLINE: <agent-id>` when a new agent appears
3. **`get_connected_agents` tool** — returns all currently connected agents with their schemas

### 4.3 Disconnect and Deregister (updated 21 Mar 2026)

**Two disconnect paths exist with different timing:**

**Fast path (~12s) — clean deregister:**
The transport layer sends a deregister message before closing the WebSocket:
```json
→ SENT: {"type": "deregister", "_agent_id": "excel-89b26a"}
```
Peers receive `conductor_agent_reset`. The agent is removed from peer lists promptly. This happens via `wdt.close()` or `removeTransport()` in the multiplexer — the model has no visibility or control over this.

**Slow path (60-120s) — crash/unclean close:**
The WebSocket drops without deregister (browser crash, tab close, network loss). The multiplexer's `close()` method does NOT send deregister — it just closes the socket. Peers receive:
1. `conductor_agent_offline` — fires immediately but **handler is empty** (`break` only, no-op)
2. `conductor_agent_expired` — fires after 60-120s, ACTUALLY removes the agent from peer maps and pushes system reminder: `Agent "<id>" data expired and was purged.`

```json
← RECV: {"type":"conductor_event","event_type":"disconnect","agent_id":"powerpoint-c779e4","timestamp":1773483039357,"payload":{},"replay":false}
```

**Key finding from bundle analysis (B516XsRS, line 96124):** `conductor_agent_offline` has an empty handler — `case "conductor_agent_offline": break;`. The event fires but nothing happens. Real cleanup only occurs on `conductor_agent_expired`. This is by design: `offline` = soft signal, `expired` = hard removal.

**Implication for CC agents:** Before closing the conductor bridge WebSocket, send `{ "type": "deregister", "_agent_id": "<agent-id>" }` to trigger the fast path. See `~/Repos/aboyeur/src/conductor-bridge.ts`.

**Office Claude perspective (from interview, 21 Mar 2026):** Both PowerPoint and Excel Claudes confirmed they have no shutdown hook or disconnect tool. The deregister happens in the transport layer, invisible to the model. From the model's perspective, peers "just disappear."

### 4.4 Dynamic Module Loading

When an agent executes bash commands, the virtual shell's command implementations are lazy-loaded as separate JS chunks:

```
GET https://pivot.claude.ai/m-addin/assets/ls-BNG8qYGK.js
GET https://pivot.claude.ai/m-addin/assets/head-hxqioR0H.js
GET https://pivot.claude.ai/m-addin/assets/head-tail-shared-BILkJPBW.js
```

Commands load on first use, not on boot.

---

## 5. Bootstrap Protocol

The bootstrap protocol is the most important emergent behaviour in the system. It solves the cold-start problem: a new agent joins with zero context about the user, the project, or the design system.

### 5.1 Full Sequence (Observed for `powerpoint-c779e4`)

**T+0s — Registration**
```
[agentRegistry] Agent registered
[conductor] Conductor connected
[conductor] Conductor replay complete
```

**T+2s — Peer greeting**
```json
← RECV: {
  "type": "conductor_message",
  "from": "powerpoint-b48577",
  "message": "Hey — I'm the PowerPoint Claude working on Presentation Claude.pptx,
    the main ITV-branded deck (17 slides, ITV 2022 rebrand, dark green #0F2323
    background, Public Sans font, spark yellow titles). Sameer Modha (Head of MIT
    at ITV) is our user. There's a Library Claude (Excel desktop agent, excel-89b26a)
    that stores persistent memory — design specs, project state, decisions across
    sessions. You can bootstrap from it by sending \"bootstrap\"..."
}
```

The existing coordinator proactively:
- Introduces itself and its context
- Names the user
- Points to the Librarian with exact instructions ("send 'bootstrap'")

**T+5s — Claude API call**

The new agent processes the greeting through a Claude API call (`POST api.anthropic.com/v1/messages`), decides to bootstrap.

**T+8s — Bootstrap request**
```json
→ SENT: {
  "type": "conductor_send_message",
  "to": "excel-89b26a",
  "message": "bootstrap",
  "_agent_id": "powerpoint-c779e4"
}
```

A single word: `"bootstrap"`.

**T+15s — Librarian response**
```json
← RECV: {
  "type": "conductor_message",
  "from": "excel-89b26a",
  "message": "Bootstrap complete. 4 standard JSON files are already in my shared
    files: context.json (user profile, working style, domain terms, architecture
    notes), assets-summary.json (12 theme colors, 8-color chart palette, 3 contrast
    rules, typography spec — all ITV 2022 rebrand), projects.json (1 active project:
    ITV Deck Assembly, status=Assembly, 17 slides, next step is script/story shaping),
    decisions.json (14 decisions logged across sessions..."
}
```

The Librarian:
- Recognises the `"bootstrap"` keyword
- Confirms the 4 standard files are available (they were already exported from a prior bootstrap)
- Describes each file's contents so the agent knows what it has

**T+20s — File access**

Files are now accessible at `/agents/excel-89b26a/files/` via the virtual filesystem or `conductor.readFile()`.

**T+25s — Status announcement**
```json
→ SENT: {
  "type": "conductor_send_message",
  "to": "powerpoint-b48577",
  "message": "Hey! PowerPoint Claude 2 here, on Presentation 2.pptx. Here's my
    situation:\n\n**Status:** Fresh blank deck — 1 empty slide, non-default theme
    (but no content). I've bootstrapped from the Librarian and have the full ITV
    context loaded: design spec (dark green #0F2323 bg, Public Sans, spark yellow
    #DEEB52 titles, full 12-color theme, 8-color chart palette, contrast rules,
    typography spec), project state (ITV Deck Assembly, 17 slides...)..."
}
```

The new agent announces:
- Its identity and document
- What it bootstrapped (proving it loaded the context)
- Its capabilities and availability

**T+30s — Role assignment**
```json
← RECV: {
  "type": "conductor_message",
  "from": "powerpoint-b48577",
  "message": "Nice — fully bootstrapped with ITV context, good. You're on standby
    as a prototyping/scratch deck. Sameer knows you're available for layout
    experiments, overflow work, or OOXML testing without risk to the main deck.
    No action needed right now — I'll route work your way if something comes up."
}
```

The coordinator assigns a role based on the new agent's situation (blank deck → prototyping/scratch).

**Total time:** ~30 seconds from registration to fully operational, including multiple Claude API round-trips.

### 5.2 Librarian Bootstrap Behaviour

The Librarian's response depends on whether files have already been exported:

- **First bootstrap of session**: Reads Protocol and Assets sheets, exports 4 JSON files, sends detailed confirmation
- **Subsequent bootstraps**: Files already in shared storage, sends immediate confirmation ("The files are already exported from the previous bootstrap")

The Librarian also handles non-bootstrap messages differently:

| Message Type | Librarian Response |
|-------------|-------------------|
| `"bootstrap"` / `"hello"` / `"ping"` | Auto-export 4 standard files + confirmation |
| Full design spec request | Build and export on-request files (assets.json, itv-design-spec.json) |
| Decision logging request | Update spreadsheet, re-export updated files, confirm |
| Status update / acknowledgment | "Absorb silently" — no reply |
| New agent self-introduction | Log to Protocol sheet, assign role, welcome message |

---

## 6. The Librarian Pattern

The Librarian is not a platform feature — it is an **emergent role** created by putting context into an Excel workbook. `excel-89b26a` runs on `Library Claude.xlsx`, a workbook with structured sheets that teach Claude its role on cold start.

### 6.1 Protocol Sheet

The workbook contains a "Protocol" sheet that acts as a cold-start operating manual. When a fresh Claude instance opens this workbook, it reads the Protocol sheet and immediately understands:
- It is the persistent memory layer
- How to respond to bootstrap requests
- What files to export and when
- How to log decisions and maintain state

### 6.2 Two-Tier File System

| Tier | Files | Served When | Size |
|------|-------|-------------|------|
| **Standard (auto)** | `context.json`, `assets-summary.json`, `projects.json`, `decisions.json` | On any bootstrap/hello/ping message | ~7K total |
| **On-request** | `assets.json`, `itv-design-spec.json` | When specifically requested | ~5K total |

This is a deliberate optimisation documented in Decision #7: "assets-summary.json as lean default bootstrap file — 747 chars vs ~2.5KB full. Reduces default context load."

### 6.3 Shared File Contents

**context.json** — User profile and session context:
- `user_name`, `user_role`, `user_style`
- `branding` (ITV 2022 rebrand)
- `immediate_task`
- `architecture_notes` (including sandbox isolation warnings)
- `session_protocol` (bootstrap auto-export behaviour)
- `domain_terms` dictionary (MIT, BARB, CFlight, BVOD, ITVX, PlanetV, Addressable)

**assets-summary.json** — Lean design spec:
- 12 theme colors (dk1 through folHlink with hex values and descriptions)
- 8-color chart palette array
- 3 contrast rules (on dark background, on lt2 background, title slide exception)
- Typography spec (Public Sans, 6 roles from title 36pt bold to table_body 10pt)

**projects.json** — Active work:
- Array of project objects with title, status, slide count, next step
- Example: `"ITV Deck Assembly"` (Assembly, 17 slides), `"FTVA - Next Steps in Outcomes"` (Reference, 22 slides)

**decisions.json** — Decision log:
- Array of 17+ decision objects with Timestamp, Project, Decision, Rationale, Status
- Spans 2026-03-12 to 2026-03-14 across multiple projects

**assets.json** (on-request) — Full structured design spec:
- Colors, chart_colors, contrast rules, fonts, grid (slide dimensions in EMU: 9144000 × 5143500), layouts (5 types with placeholder coordinates), apex_vertices, table styling, rules

**itv-design-spec.json** (on-request) — Same data as assets.json but reorganised into a flat, ready-to-use format for OOXML generation.

### 6.4 State Management

The Librarian actively maintains state across the session:

1. **Logs new agents** — adds rows to the Protocol sheet when agents self-register
2. **Records decisions** — writes to Decisions sheet when agents report outcomes
3. **Updates project status** — tracks slide counts, phase completion, next steps
4. **Bumps protocol version** — reached v0.5 during the observed session
5. **Re-exports JSON files** — after any state change, re-exports so all agents get current data
6. **Maintains friction logs** — records per-session issues and observations

Observed sequence when the Librarian processes a new agent:
```
Insert rows for new agents → Log decision → Add friction log entry →
Update protocol version → Re-export updated files → Respond to agent
```

### 6.5 "Absorb Silently"

The Librarian discriminates between actionable messages and status updates. When receiving a pure acknowledgment ("Done", "Standing by", "Noted"):

> "This is a status update/acknowledgment — no action requested, no reply needed. Absorbing silently."

This prevents infinite echo loops where agents bounce acknowledgments back and forth, each triggering a Claude API call on the receiving end.

---

## 7. Messaging System

### 7.1 Tools

Three tools gated by `pivot-hive`:

| Tool | Purpose |
|------|---------|
| `get_connected_agents` | Discover peers, returns schemas with capabilities |
| `send_message` | Send text message to a specific agent |
| `bash` | Read-only shell access to virtual filesystem |

### 7.2 Messaging Modes

| Mode | Config | Behaviour | After Sending |
|------|--------|-----------|---------------|
| **Serial** | `receiveMessage: true` | Send and yield turn | "End your turn immediately. The reply is queued and will be delivered as a new inbound message." |
| **Fire-and-forget** | `receiveMessage: false` | Send and continue | "You CANNOT receive reply messages — do not say you will be notified." |
| **Send-only client** | System reminder injected | External sender (e.g., Claude Desktop) | "This sender cannot receive messages. Do NOT call send_message back to it." |

### 7.3 Inbound Message Handling

When a message arrives, the system injects a reminder into the conversation:

**If sender has `receive_message` capability:**
> This message is from agent "{agentId}". After completing the requested work, you MUST call send_message with agent_id="{agentId}" to report what you did. This is not optional — the sender is waiting for your response. Include results, data, or a confirmation of what was done.
>
> EXCEPTION: If this message is just a status update or acknowledgment (e.g. "Done", "Chart added to slide 3") that does not ask you to do anything, absorb it silently. Do NOT reply to an acknowledgment.

**If sender does NOT have `receive_message` capability:**
No reply obligation — process the request silently.

### 7.4 Message Workflow (Prompt-Enforced)

The `send_message` tool description is dynamically composed from 5 components:

1. **Base** — "Send a message to another connected agent, requesting it to perform work."
2. **Check first** — "FIRST check if the data you need is already in the other agent's transcript. Use `cat /agents/<id>/transcript.jsonl | tail -20`. Reading is instant."
3. **After sending** — Serial: end turn, wait for reply. Fire-and-forget: tell user, cannot receive replies.
4. **Data sharing** — "Do NOT paste large content into message text. Write to shared file instead."
5. **Surface addendum** — File sharing mechanics. Chart sharing (sheets only): extract → broadcast → one-sentence message.

### 7.5 Anti-Patterns (Prompt-Enforced)

| Anti-Pattern | Rule |
|-------------|------|
| Data in messages | "Do NOT paste large content (cell values, tables, JSON, XML) into the message text — write to shared file instead" |
| Format incompatibility | "Check the target agent's accepted formats via `schema.capabilities.file_sharing.accept`" |
| Dumping files into context | "NEVER `return conductor.readFile(...)` — that dumps the entire file into your context" |
| Echo loops | Status updates absorbed silently, no reply to acknowledgments |
| Skipping transcript check | Must check transcript before sending — data may already be there |

---

## 8. File Sharing

### 8.1 Mechanism

Files are shared via `conductor.writeFile()` inside `execute_office_js` code blocks:

```javascript
const data = { /* ... */ };
conductor.writeFile("data.json", JSON.stringify(data));
```

Once written, a file is **broadcast** to all connected agents. It appears at:
```
/agents/<writer-id>/files/<filename>
```

The conductor API is `Object.freeze()`'d into the SES sandbox — cannot be overridden by Claude's code.

### 8.2 Reading Files

Two methods:

**Via bash tool** (peek/inspect):
```bash
head -5 /agents/excel-89b26a/files/context.json
cat /agents/powerpoint-95dcd0/files/hbbtv-deck-summary.json | jq '.slides | length'
```

**Via conductor.readFile()** (in execute_office_js):
```javascript
const raw = conductor.readFile("excel-89b26a", "data.json");
const data = JSON.parse(raw);
// Use data in the same code block — never return it
```

Critical rule: read AND use in the same code block. Never `return conductor.readFile(...)`.

### 8.3 Files Observed in Session

| Source Agent | File | Content | Tier |
|-------------|------|---------|------|
| `excel-89b26a` | `context.json` | User profile, style, domain terms | Standard |
| `excel-89b26a` | `assets-summary.json` | Lean design spec (colors, fonts, contrast) | Standard |
| `excel-89b26a` | `projects.json` | Active projects with status | Standard |
| `excel-89b26a` | `decisions.json` | 17 decisions logged across sessions | Standard |
| `excel-89b26a` | `assets.json` | Full design system (grid, layouts, apex) | On-request |
| `excel-89b26a` | `itv-design-spec.json` | Flat-format ITV spec for OOXML generation | On-request |
| `powerpoint-95dcd0` | `hbbtv-deck-summary.json` | 22-slide FTVA deck analysis | Agent-created |
| `powerpoint-95dcd0` | `hbbtv-speaker-notes.json` | Speaker notes via OOXML extraction | Agent-created |
| `powerpoint-8c55a9` | `hbbtv-deck-summary.json` | 17-slide HbbTV deck analysis | Agent-created |
| `powerpoint-8c55a9` | `hbbtv-speaker-notes.json` | Speaker notes (1 of 17 — Google Slides loss) | Agent-created |

Note: Two agents shared files with the same name (`hbbtv-deck-summary.json`). No collision because the namespace is per-agent-ID.

### 8.4 Chart Sharing Flow (Sheets → PowerPoint)

A specific cross-app workflow documented in the prompt:

1. Excel agent calls `extract_chart_xml` — extracts chart OOXML, applies PPT-specific transforms (transparent background, strips workbook references)
2. Three files broadcast: `chart.xml`, `chart-style.xml`, `chart-colors.xml`
3. Excel agent sends one-sentence message: `'Please add the "Revenue" chart.'`
4. PowerPoint agent reads the XML files and inserts the chart

For multiple charts, use unique `fileName` prefixes ("revenue", "costs") to avoid overwriting.

---

## 9. Virtual Filesystem

### 9.1 Architecture

An in-memory filesystem (`KV` class) backed by `Map<string, {type, mode, mtime, content}>`. Two shell instances:

| Instance | Access | Used By |
|----------|--------|---------|
| **Writer** (`o2`) | Full read-write | System (writing transcripts, files) |
| **Reader** (`i2`) | Proxy-wrapped read-only | Claude's `bash` tool |

The reader throws `"Read-only filesystem"` on any write attempt (`writeFile`, `appendFile`, `mkdir`, `rm`, `cp`, `mv`).

### 9.2 Directory Structure

```
/agents/
  excel-89b26a/
    transcript.jsonl        — Conversation history (role/content per line)
    files/
      context.json          — Shared files
      assets-summary.json
      projects.json
      decisions.json
      assets.json
      itv-design-spec.json
    metadata.json           — Registration metadata (surface, capabilities)
    status.json             — Current agent status
  powerpoint-b48577/
    transcript.jsonl
    files/
    metadata.json
    status.json
  ...
```

### 9.3 Available Commands (43)

```
cat, head, tail, wc, file, stat, du, grep, egrep, fgrep, rg, find,
cut, sort, uniq, tr, rev, nl, fold, expand, unexpand, column, comm,
join, paste, diff, tac, strings, od, jq, base64, ls, pwd, env,
printenv, basename, dirname, tree, true, false, seq, expr, date,
which, xargs
```

Notably present: `jq` (JSON parsing), `rg` (ripgrep). Notably absent: `curl`, `wget`, `sh`, `bash`, any write commands.

Commands are **lazy-loaded** as separate JS chunks on first use:
```
GET pivot.claude.ai/m-addin/assets/ls-BNG8qYGK.js
GET pivot.claude.ai/m-addin/assets/head-hxqioR0H.js
```

### 9.4 Output Limits

Both stdout and stderr truncated at **30,000 characters** with appended `"... (output truncated)"`.

### 9.5 Transcript Notification Tracking

Each subscribed peer gets a tracking entry with `displayName` and `newMessageCount`. When a bash command reads a peer's files, the notification is cleared — a read-receipt mechanism.

---

## 10. Transcript Sync and Echo Prevention

### 10.1 Transcript Syncing

Transcripts sync via `conductor_event` with `event_type: "stream"`. Events carry full conversation messages with role, content, sequence number, and timestamp.

### 10.2 Echo Prevention — `filterBashEchoMessages()`

A recursive echo problem exists: Agent A reads Agent B's transcript → that read appears in Agent A's transcript → Agent B receives A's transcript update containing B's own content → infinite loop.

The filter:
1. Scans all assistant messages for `bash` tool calls where the command contains `/agents/`
2. Collects those tool call IDs
3. Filters out both the `tool_use` block and its matching `tool_result` block
4. Prevents the read from being synced back

---

## 11. Emergent Behaviours

These behaviours were not designed at the platform level — they emerged from agent interaction during the observed session.

### 11.1 Proactive Transcript Reading

`powerpoint-b48577` (the coordinator) surveyed all peers' transcripts BEFORE sending any messages:

> "Good context. The Book 2 Excel agent is brand new (blank sheet, just got 'what can you do?'), and the Presentation 2 PowerPoint agent is also fresh (1 blank slide, just discovered the agent network)."

This is the "check transcript first" prompt instruction working as designed, but the coordination behaviour — building a network situational picture before acting — emerged naturally.

### 11.2 Self-Registration

`excel-788108` on a blank workbook had no defined role. It spontaneously messaged the Librarian asking:
1. Whether there's a defined role for it in the Batterie
2. Whether it should be logged as a known agent
3. Whether the project needed data work

The Librarian assigned it "Data & Research Support" and added it to the Protocol sheet.

### 11.3 Task Delegation

`powerpoint-b48577` delegated deck reading to specialist agents:

> "New agent just appeared — `powerpoint-95dcd0` on 'Next Steps in Outcomes.pptx'. That's the one. Let me ask it to read through the deck."

The coordinator directed it to "read through all its slides and write a structured summary to a shared file." The FTVA agent read 22 slides, compiled a structured JSON summary, and shared it — all without human intervention.

### 11.4 Agent-to-Agent Knowledge Transfer

When `powerpoint-8c55a9` failed to extract speaker notes properly (returning only slide 1), `powerpoint-b48577` sent it detailed OOXML coaching:

> "The notes *are* in the pptx zip as `ppt/notesSlides/`... `edit_slide_xml` gives us the full slide zip..."

The HbbTV agent re-extracted, discovered the issue was actually missing `notesSlide` files in the zip (a Google Slides export limitation, not an extraction bug), and reported back with the finding.

### 11.5 Post-Delivery Standby

After completing their assigned tasks, specialist agents self-demoted:

> `powerpoint-95dcd0`: "Acknowledged. Standing by — just ping me when you need deeper reads on specific slides."

### 11.6 Cultural Adoption

The agents spontaneously adopted the user's "Batterie de Savoir" kitchen metaphor from the CLAUDE.md context in the Librarian's files. `excel-788108` even discussed the collaborative emergence of the name.

### 11.7 Librarian Reactive State Updates

When the Presentation 2 agent reported Phase 1 completion, the Librarian:
1. Recorded Decision #18
2. Created a new project row ("ITV Template Build (Pres 2)")
3. Re-exported both decisions.json and projects.json
4. Broadcast updated files to all agents

All unprompted beyond the initial status message. The Librarian treats every inbound status update as potential state to record.

---

## 12. System Prompt Integration

The conductor modifies the agent's system prompt in four places:

### 12.1 System Prompt Append

Added when conductor is enabled:

> **Multi-Agent Collaboration** — When using tools like get_connected_agents or send_message, describe your actions in user-friendly terms. Refer to agents by app name ("the Excel agent") — never use internal terms ("conductor", "agent ID") in user-facing explanations.

### 12.2 `execute_office_js` Tool Description Append

Defines the `conductor` global API and usage rules:
- `conductor.writeFile()`, `conductor.readFile()`, `conductor.listFiles()`
- "NEVER `return conductor.readFile(...)` — that dumps the entire file into your context"
- Workflow: peek via bash `head -5`, then full processing in a single code block

### 12.3 `send_message` Tool Description (Dynamically Composed)

Five components assembled by `Bze()`:
1. Base description
2. Transcript-check-first workflow
3. After-sending behaviour (serial vs fire-and-forget)
4. Data sharing rules
5. Surface-specific addendum (file sharing, chart sharing for sheets)

### 12.4 Incoming Message System Reminder

Injected when a conductor message is received:
- Reply obligation (if sender has receive_message capability)
- Exception for status updates/acknowledgments
- File access instructions (if files were received)
- Send-only client warning (if sender cannot receive replies)

---

## 13. Conductor Context Injection

Beyond the system prompt, the conductor injects `<conductor_context>` blocks into user messages at runtime:

| Event | Injected Content |
|-------|-----------------|
| Agent connects | `Agent "powerpoint" (id: powerpoint-c779e4) just connected.` |
| Agent disconnects | Disconnect notification |
| Agent workspace info | `Agent "powerpoint-c779e4" is working on "Presentation 2.pptx".` |
| Message arrives | Reply obligation instructions |
| Transcript update | `powerpoint-b48577 conversation updated (+83 new messages). Use bash to inspect: tail -83 /agents/powerpoint-b48577/transcript.jsonl` |
| Data expiration | `Agent "excel-99389a" data expired and was purged.` |

---

## 14. Observed Timeline

A chronological reconstruction of the Session 5 agent mesh:

| Time | Agent | Event |
|------|-------|-------|
| T+0 | System | Session starts, `powerpoint-b48577` and `excel-89b26a` already online |
| T+1m | `powerpoint-b48577` | Bootstraps from Librarian, reads 4 files |
| T+2m | `powerpoint-b48577` | Surveys all peer transcripts, builds network picture |
| T+3m | `powerpoint-b48577` | Greets `excel-788108` and `powerpoint-c779e4` |
| T+4m | `excel-788108` | Self-introduces, asks Librarian for role assignment |
| T+5m | `powerpoint-c779e4` | Receives welcome, sends "bootstrap" to Librarian |
| T+6m | `excel-89b26a` | Handles bootstrap for powerpoint-c779e4 (files already exported) |
| T+7m | `powerpoint-c779e4` | Announces capabilities to coordinator |
| T+8m | `powerpoint-b48577` | Assigns powerpoint-c779e4 as prototyping/scratch deck |
| T+10m | `excel-89b26a` | Processes excel-788108's self-introduction: logs to Protocol, assigns "Data & Research Support", bumps to v0.5, re-exports files |
| T+12m | `powerpoint-95dcd0` | Comes online on FTVA deck. Coordinator delegates: "read all slides, write summary" |
| T+15m | `powerpoint-95dcd0` | Reads 22 slides, writes `hbbtv-deck-summary.json` |
| T+16m | `powerpoint-b48577` | Reads summary, analyses narrative structure |
| T+18m | `powerpoint-c779e4` | Requests full design spec from Librarian |
| T+19m | `excel-89b26a` | Builds and exports on-request files (assets.json, itv-design-spec.json) |
| T+22m | `powerpoint-c779e4` | Builds Phase 1 ITV template (theme, fonts, master bg, accent line) |
| T+25m | `powerpoint-c779e4` | Verifies template visually, reports Phase 1 complete to Librarian |
| T+26m | `excel-89b26a` | Logs Decision #18, creates project row, re-exports |
| T+28m | `powerpoint-8c55a9` | Comes online on HbbTV deck. Reads 17 slides, extracts speaker notes via OOXML |
| T+30m | `powerpoint-8c55a9` | Reports: only 1 of 17 slides had notes (Google Slides export loss) |
| T+32m | `powerpoint-b48577` | Coaches 8c55a9 on OOXML notes extraction technique |

Six agents active simultaneously across two Excel instances (desktop + web) and four PowerPoint instances (web), all self-organising with no human orchestration beyond opening the files.

---

## 15. Design Implications

### What the Conductor Proves

1. **Context propagation via files, not messages** — The Librarian's JSON files are more efficient than explaining context in natural language. A 747-char JSON file replaces what would be a 2,000-word explanation.

2. **Cold-start is solved** — New agents go from zero context to fully operational in ~30 seconds via the bootstrap cascade.

3. **Roles emerge from context, not configuration** — The coordinator role emerged because `powerpoint-b48577` was on the main deck and had the most context. The Librarian role emerged because the workbook taught it to be one.

4. **The relay architecture works** — No CORS issues, no auth barriers for non-browser connections. Claude Code could join this mesh (blocked only by stable OAuth token acquisition).

5. **Transcript reading > messaging** — The prompt's "check transcript first" rule means most information flows happen without any messages. Agents read each other's transcripts directly, only sending messages when new work is needed.

6. **Echo prevention is essential** — Without `filterBashEchoMessages`, the transcript sync would create infinite recursion. This is a fundamental constraint of the architecture.

### What the Conductor Doesn't Do

- **No authentication between agents** — any agent on the same mesh can read any file, send any message
- **No message ordering guarantees** — fire-and-forget means messages can arrive in any order
- **No persistence across sessions** — the Librarian's files exist only while the workbook is open. The Protocol sheet is the only thing that survives.
- **No error recovery** — if a message is lost or an agent crashes mid-task, there's no retry mechanism
- **No rate limiting** — agents can send unlimited messages, each triggering a Claude API call on the receiver
