# Chronicle

Local-first session-data engine for an AI coding stack. It reads the transcripts your coding tools already write, normalizes them into one local SQLite database, and serves browsing, analytics, playback and redaction over them. This file is the glossary: the words the code, the specs and the docs all use for the same things.

## Language

### The record

**Session**:
Chronicle's record of one run of a coding tool, and the unit everything else is scoped to.
_Avoid_: conversation, chat, thread.

**Transcript**:
The file a coding tool writes for a session, read-only input Chronicle never modifies. Where it lands is that tool's business.
_Avoid_: log (reserved for the view log), history.

**Message**:
One normalized row of a session: user, assistant, thinking, tool_use or tool_result. The five kinds are closed.
_Avoid_: event (the parser's own word for a message before it is stored), entry, line.

**Turn**:
One assistant message. Used where the count of assistant responses is the point, as in subagent turns.

**Kind**:
Which of the five kinds a message is. Distinct from `source` and from `provider`.
_Avoid_: type, role.

**Project**:
The working directory a session ran in, keyed on that path. A project is not necessarily a Git repo; when it is, time travel is available.
_Avoid_: workspace, repo, folder.

**Snapshot**:
The Git commit that stood at the moment of a given message. Time travel pairs a message with its snapshot.

**Time travel**:
Reading the code as it stood at a message's snapshot, reconstructed from Git commits. Available only for a project that is a Git repo.

**Tombstone**:
The marker left when a session is removed, so a later sync does not re-import it.

### Getting data in

**Source**:
Which coding tool a session came from: claude-code, codex, cursor, opencode. The tool vendor, never the model vendor.
_Avoid_: tool, agent, integration, connector, source client.

**Parser**:
The reader for one source, turning its transcripts into sessions and messages. One parser per source.

**Import**:
Bringing a project's sessions into Chronicle for the first time, operator-initiated.

**Sync**:
Re-reading a source's transcripts to refresh what is already imported. Incremental: only sessions whose transcript changed are re-parsed.
_Avoid_: ingest, refresh, update, scan (scan is the pre-import listing of what is importable).

**Autosync**:
Sync that runs on its own, without the operator asking.

**Live**:
A session still being written by its tool, streamed into the open session view as it happens.

**Minor session**:
A session the noise gate marked as too small to be worth listing. Hidden from the main lists, promotable by hand.

**Noise gate**:
The rule that marks a session minor: short on both axes at once, agent-active time and message count.

**Demo**:
The mode that serves synthetic sessions and projects so a fresh machine has something to look at. Every runner refuses to spawn in demo.
_Avoid_: sample, fixture (fixtures are a test thing).

### Reading the data

**Insights**:
The home surface at `/`, the one place cross-project analytics live. Never called Home.

**Scope**:
Which sessions an engine query covers: all, one project, or one session. Every analytics engine takes one.

**Range**:
The time filter on a surface: Today, 7d, 30d, 90d, All.
_Avoid_: window (reserved for plan window and context window), period.

**Playback**:
Stepping through a session's messages in order, with each message's snapshot beside it.
_Avoid_: replay.

**Refine**:
The session mode for trimming and annotating a session before it is shared.

**Security Check**:
The session mode that scans a session against the redaction rules and shows what would be redacted.

**Explore**:
The pivot surface: pick a dimension and a metric, get a chart. Dimensions include model, project, source, provider, tool, skill, subagent and MCP server.

**Content**:
The surface describing what a session was made of: token composition by kind, tool results, skills, subagents, and the characteristics list.

**Reference**:
The in-app page defining every metric and term on the surfaces, rendered from the one definitions registry the ⓘ tips also read. The one place a retired surface's vocabulary may still be named.

**Ask**:
The one model run in the product: an operator-initiated local `claude -p` over a read-only, SELECT-only handle on Chronicle's own database. Off by default.

**View log**:
Chronicle's local record of which of its own surfaces got looked at, actor-tagged, browser-driven only. Never leaves the machine. Unrelated to a source transcript.

### Money and tokens

**Spend**:
Dollars, at whichever cost basis is selected. The Insights tab of the same name.
_Avoid_: burn, cost (cost is fine for one figure, spend for the subject).

**Cost basis**:
Which price a dollar figure is computed at, chosen globally and always labeled next to the number: **List price** (metered list rate) or **Billed** (what the operator actually pays, so subscription-covered models read about zero).
_Avoid_: theoretical, real, mode.

**Usage**:
A session's token totals per model, split by input, output, cache read, and cache writes at each cache lifetime.

**Exact vs calibrated**:
A figure is **exact** when it comes straight from billed token counts, and **calibrated** when tokens are attributed by share of text length and scaled to a real billed total. Calibrated figures say so on the surface.
_Avoid_: estimated, approximate, derived.

**Plan window**:
A subscription's rate-limit period and how much of it is consumed: 5h, 7d and the top-tier window for Claude, 7d for Codex. One card per account.
_Avoid_: quota, limit, usage window.

**Context window**:
A model's maximum token capacity for one request. A constant of the model, never a price and never a time range.

**Anomaly**:
A day whose spend runs far above the trailing median of active days. Lives on the Overview tile and nowhere else.

**Detector**:
One of the four Efficiency rates: cache hit rate, jumbo outputs, long context, error rows. A rate plus the word grading it.

**Waste signal**:
An estimated dollar figure for spend that need not have happened: right-sizing, cache churn, repeat file reads.

**Agent active**:
Time the coding tool was working, summed from message gaps.

**Engaged**:
Time the operator was at the keyboard, the human side of the same span. Always paired with agent active, never used alone as "time".
_Avoid_: wall time, session length.

### Subagents

**Subagent**:
A nested agent a session spawned, whose messages are recorded as part of the parent session.
_Avoid_: sidechain (the storage flag's word), child agent.

**Agent type**:
What kind of subagent it is. Many runs share one type.

**Run**:
One execution of a subagent, the counted unit on the Subagents card. Distinct from type and from turn.

**Workflow**:
A group of subagent runs a source tool nested together.

**Skill**:
A named capability a session invoked, priced and counted like any other dimension.

**MCP server**:
An external tool server a session called, one of the Explore dimensions and a spend row.

### Redaction

**Redaction**:
Replacing secrets in a session's text before it leaves the machine. A promise about the share and export boundary, not a claim about the local database.
_Avoid_: sanitize, scrub, masking.

**Rule**:
One redaction pattern: a glob, its replacement, and whether it redacts or allows. Built-in rules ship with Chronicle; the operator adds their own and can override a built-in.

**Finding**:
One hit of a rule against a piece of text.

### The machine

**Operator**:
The one human running Chronicle on their own machine. Chronicle has no accounts and no second user.
_Avoid_: user, customer, you (in agent-facing docs).

**Data folder**:
`~/.chronicle`, or `$CHRONICLE_DATA_DIR`. Chronicle's database, config and Ask history, and the only place it writes.

**Write token**:
The per-boot value every mutating route demands, a same-origin guard and nothing more. Not auth.
_Avoid_: gate, auth, CSRF token.
