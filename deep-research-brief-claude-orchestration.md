# Deep Research Brief: Claude-to-Claude Orchestration Patterns

## Context for the researcher

Sameer Modha runs a personal toolkit ("Batterie de Savoir") that extends Claude Code with session memory, work tracking, and browser automation. He already has:

- **Gueridon** — a Node.js bridge that spawns Claude Code processes from a mobile web UI. It sidesteps the "Claude spawning Claude" block by stripping `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` environment variables before spawning child processes. Proven, battle-tested, in daily use.
- **Aboyeur** — a shell-based conductor that alternates worker and reflector Claude sessions, using handoff files (markdown) as the protocol between them. Alpha stage, ~500 lines. The intelligence lives in prompt files, not the conductor.
- **Bon** — a CLI work tracker (desired outcomes, next actions, tactical steps) whose state can be hashed for progress detection.
- **Handoffs** — structured markdown files written at session end, read at session start. The cross-session memory protocol.
- **Garde-manger** — searchable archive of past session transcripts.

The goal is to evolve these into a system where one Claude orchestrates other Claudes — generating prompts (high leverage: one orchestrator token steers hundreds of worker tokens), holding memory context, and routing work. The human's role shrinks to occasional review and course correction.

## Research questions

### 1. Claude Code Agent Teams — real-world reliability and architecture

Claude Code has an experimental feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) that lets a "lead" Claude spawn "teammates" — each a full CC session with its own context window. They communicate via a shared task list and mailbox system.

**Find out:**
- What is the actual architecture? How does the lead spawn teammates — is it `claude -p` under the hood, or something else? What's the IPC mechanism (files, sockets, shared memory)?
- How does task claiming work? The docs mention file locking — where are these files? What format?
- What's the mailbox system? Can teammates message each other, or only the lead?
- What are the real failure modes? People report buggy shutdown, no resume support, teammates that zombie. Find concrete bug reports, GitHub issues, forum complaints.
- Does it load CLAUDE.md, skills, and MCP servers for each teammate? (Docs say yes — verify with real user reports.)
- Can it work WITH Gueridon? Or do they conflict? (Gueridon manages one CC process per folder; Agent Teams spawn their own processes in the same folder.)
- What happens to teammate context when the lead's context fills up? Does the lead lose track of what teammates are doing?
- Is there a way to inject custom system prompts into teammates, or do they only get the standard project context?

**Key sources to check:**
- Official docs: code.claude.com/docs/en/agent-teams
- Anthropic's blog post about building a C compiler with 16 agents / 2000 sessions
- Addy Osmani's writeup on Claude Code Swarms
- GitHub issues on the Claude Code repo mentioning agent teams
- The alexop.dev "From Tasks to Swarms" post
- Community Discord / forum reports of real usage

### 2. NanoClaw — architecture deep dive

NanoClaw (github.com/qwibitai/nanoclaw) is a ~500-line TypeScript framework that connects Claude to messaging apps (WhatsApp, Telegram, Slack, Gmail), runs sessions in isolated containers, and supports "Agent Swarms."

**Find out:**
- How does it spawn Claude sessions? Does it use the Agent SDK, `claude -p`, or direct API calls?
- What's the "Agent Swarms" feature? How do multiple agents coordinate? Is it prompt-chaining, shared state, or something else?
- How does it handle memory/continuity? It claims to have memory — what format, where stored, how retrieved?
- How does the "Heartbeat" scheduler work? Is it cron, polling, or event-driven?
- What's the Gmail integration pattern? Does it poll IMAP, use the Gmail API, or use a webhook?
- Container isolation: Apple Containerization on macOS, Docker elsewhere — how does it pass credentials and API keys into the container?
- How does it handle the context window limit for long-running agents (inbox watchers)?

**Key sources:**
- GitHub repo: qwibitai/nanoclaw (README, source files — there are only ~15)
- nanoclaw.dev documentation
- The New Stack article on NanoClaw's minimalist approach
- The CLAUDE.md in the repo (they publish it)
- Any Discord/community discussion of real deployments

### 3. OpenClaw — what's worth stealing

OpenClaw is huge (247k stars) and messy, but its 5-component architecture (Gateway, Brain, Memory, Skills, Heartbeat) maps loosely to what we're building. The creator (Peter Steinberger) has joined OpenAI, so the project's future is uncertain.

**Find out:**
- The **Heartbeat** component: how does it schedule proactive agent actions? What triggers are supported (cron, webhook, email, file watch)?
- The **Memory** component: what's the format? How does it retrieve relevant context for a new session? Is it vector search, keyword, or something simpler?
- The **Gateway** abstraction: how does it normalise messages from different channels (Slack, WhatsApp, email) into a common format? This is relevant for our daemon design.
- **ClawHub skills**: what patterns emerged from 13,000+ community skills? Are there patterns for multi-agent coordination, email management, or work orchestration that we should know about?
- What are the known security concerns that prompted NanoClaw's creation? (Application-level permission checks vs OS-level isolation.)

**Key sources:**
- GitHub repo (focus on architecture docs, not the sprawling codebase)
- The Medium explainer by Steven Cen
- Wikipedia article (good timeline and architectural overview)
- The New Stack article on Anthropic/Agent SDK confusion (re: OpenClaw's relationship to official SDKs)

### 4. Claude Agent SDK — what it actually enables

Anthropic has an official Agent SDK. NanoClaw is built on it. OpenClaw is not (it predates it).

**Find out:**
- What does the Agent SDK provide that `claude -p` doesn't? Is it a wrapper around the API, or does it include orchestration primitives?
- Does it support multi-agent patterns natively? (Agent-to-agent communication, shared state, swarms?)
- Can it be used to build a thin daemon that spawns and manages agent sessions?
- How does it handle authentication — does it use the CLI's Max subscription, or does it require API keys?
- What's the relationship between the Agent SDK and Claude Code's internal agent/subagent system?

**Key sources:**
- Anthropic's official Agent SDK documentation
- GitHub repo for the SDK
- The New Stack article on SDK confusion
- Any Anthropic engineering blog posts about the SDK

### 5. Prompt-as-leverage patterns in the wild

The core thesis is that orchestrator Claudes should spend most of their tokens generating precise prompts for worker Claudes, achieving high context ratio (1 orchestrator token : 100+ worker tokens).

**Find out:**
- Are there published patterns for "meta-prompting" — one LLM generating prompts for another? Academic papers, blog posts, or frameworks.
- How do existing multi-agent frameworks handle prompt generation for sub-agents? Do they use templates, or does the orchestrator generate bespoke prompts?
- What's the failure mode when the orchestrator's prompt is too vague? Too specific? Is there research on optimal prompt granularity for delegation?
- The Anthropic C compiler project used 2000 sessions coordinated by a lead. How did the lead generate tasks? Was it hand-written task decomposition, or did the lead dynamically generate sub-tasks?

### 6. Stateless continuity — making ephemeral agents feel persistent

OpenClaw, NanoClaw, and our own system all face the same problem: agents are stateless (fresh context each session) but need to feel continuous to the user and to each other.

**Find out:**
- What patterns exist for "session hydration" — loading relevant context at session start? (Our approach: handoffs + CLAUDE.md + /open skill. What do others do?)
- How do long-running agent roles (inbox watcher, project manager) handle the context window limit? Do they checkpoint and restart? Summarise and compress? Rotate?
- Is there research on optimal memory retrieval for agent continuity? (Vector search vs recency vs task-relevance.)
- How does Anthropic's own "prompt caching" or "extended thinking" interact with multi-session patterns?

### 7. The email use case specifically

One concrete scenario: a Claude watches claude@planetmodha.com, triages incoming mail, drafts replies, and escalates when needed.

**Find out:**
- How do NanoClaw and OpenClaw handle email? Gmail API? IMAP polling? What's the latency?
- Are there examples of Claude agents managing email inboxes in production? What works, what breaks?
- How do they handle the "reply in context" problem — maintaining thread context across multiple emails and multiple agent sessions?
- What's the security model for email access? OAuth tokens, app passwords, or something else?

## Output format

For each question cluster, provide:
1. **What I found** — concrete facts, with source URLs
2. **What's uncertain** — things that were contradictory or unverifiable
3. **What's relevant to our design** — specific insights that apply to the Gueridon + Aboyeur + daemon architecture
4. **Code or config snippets** — if you find actual implementation details (spawn commands, IPC formats, memory schemas), include them

Prioritise depth over breadth. If you can only cover 4 of the 7 clusters well, do that rather than skimming all 7. The most important clusters are #1 (Agent Teams), #2 (NanoClaw), and #5 (prompt-as-leverage).
