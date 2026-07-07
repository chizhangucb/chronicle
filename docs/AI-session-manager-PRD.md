# Product Requirements Document — In-House AI Coding Session Manager

**Working title:** *Chronicle* (placeholder — an in-house "time machine" for AI coding sessions)
**Inspired by:** [Chronicle](https://chronicle.example) — AI Coding Sessions Time Machine
**Document status:** v1.0 — implemented through Phase 5 (see §9 Decision log); v0.1.0 released 2026-07-06
**Author:** Chi Zhang
**Date:** 2026-07-03
**Framing:** In-house build specification (full feature parity target, phased delivery)

---

## 1. Overview

### 1.1 Summary

We are building an in-house, local-first desktop application that ingests the conversation logs produced by AI coding assistants (Claude Code, Cursor, Gemini CLI, Codex, GitHub Copilot Chat, OpenCode) and turns them into a navigable, auditable record of *how* code came to be. The product maps every AI conversation turn to the corresponding code state, letting a developer click any message and "time-travel" to the exact code at that moment. On top of this replay core, the product layers a unified control plane for MCP services and Skills across tools, session analytics, security/redaction tooling, live streaming of in-progress sessions, and remote (SSH) session access.

The design philosophy is **Replay · Control · Secure**, and the operating constraint is **local-first**: all parsing and storage happen on the user's machine, with no mandatory cloud dependency.

### 1.2 Problem statement

Developers increasingly pair with AI coding agents that generate large volumes of code across long, sprawling sessions. This creates recurring pain:

- **No memory of *why*.** After a day of AI pair-programming, it's hard to reconstruct when a feature was added, why the AI wrote code a certain way, or what a discarded approach looked like.
- **Fragmented tooling.** The same developer uses several AI tools, each with its own log format, its own MCP config, and its own Skills directory. Nothing is unified.
- **Configuration sprawl.** MCP services and Skills must be re-declared per tool, per project, with no central permission model.
- **Security exposure.** Conversation logs routinely contain API keys, passwords, tokens, and PII. Sharing them (for review, issues, or demos) leaks secrets.
- **No observability.** There's no dashboard for how much AI assistance is used, which tools, how often it errors, or where time goes.

### 1.3 Goals

1. Reconstruct the full timeline of any AI coding session and map each message to a code snapshot (Git-backed).
2. Aggregate sessions from all major AI coding tools into a single, path-based "logical project" view.
3. Provide a unified control plane for MCP services and Skills — *import once, use everywhere* — with project-scoped permissions.
4. Detect and redact sensitive data before any session is shared, with both on-demand and real-time (pre-tool-use) protection.
5. Support in-progress ("live") sessions and remote (SSH) sessions with the same experience as local, completed ones.
6. Remain 100% local-first, offline-capable, and cross-platform (macOS, Windows, Linux).

### 1.4 Non-goals (v1)

- We are **not** building our own AI coding agent or LLM inference. The product *observes and manages* other tools; it does not replace them.
- We are **not** requiring a cloud account or backend for core functionality. Optional encrypted sync may come later.
- We are **not** editing the user's real project files during replay (replay runs in a sandbox by default).
- Team/multi-user collaboration and cloud sync are explicitly deferred (see Roadmap, Phase 5).

### 1.5 Success metrics

| Metric | Target |
| --- | --- |
| Time-to-first-"aha" (install → time travel on a real session) | < 5 minutes |
| Import speed (medium project, 100–500 messages) | < 5 seconds |
| Supported AI tools at GA | 6 (Claude Code, Cursor, Gemini CLI, Codex, Copilot Chat, OpenCode) |
| Sensitive-data detection recall on seeded secrets | > 95% |
| Live-stream added latency (new message → visible) | < 1 second |
| Memory footprint, daily use (multiple projects) | ≤ 8 GB recommended envelope |

---

## 2. Target users & personas

**Persona A — "Solo AI-first developer."** Uses Claude Code and Cursor daily. Wants to review what the AI did, recover discarded approaches, and understand code evolution. Primary value: Time Travel, Filtering, Analytics.

**Persona B — "Tooling / platform engineer."** Manages MCP services and Skills for themselves or a team. Wants a single place to configure and scope tool permissions across every AI assistant. Primary value: MCP Hub, Skills Hub, Tool Policies.

**Persona C — "Security-conscious contributor."** Shares sessions in issues, reviews, or demos. Needs to guarantee no secrets leak. Primary value: One-Click Security Check, real-time interception, redaction.

**Persona D — "Remote / cloud developer."** Runs AI tools on cloud instances or shared dev servers. Wants to review and live-watch those sessions from a laptop without copying logs down. Primary value: Remote SSH Access, Live Streaming.

---

## 3. Product principles

1. **Local-first, offline by default.** No network call is required to parse, view, or manage sessions. Original data is never mutated by viewing or sharing.
2. **Git is the source of truth for code state.** Code snapshots are reconstructed from Git history matched to conversation timestamps, not from a separate snapshot store.
3. **Takeover → Centralize → Distribute.** The unified control-plane pattern (used identically by MCP Hub and Skills Hub): import existing tool configs, store them centrally, redistribute to every tool.
4. **Read-only on foreign systems.** Remote SSH operations never write to remote servers; Cursor DB polling never writes to Cursor's database.
5. **Safe by default.** Replay runs in a sandbox; redaction is one-way; external-source cleanups require explicit confirmation; system paths are never touched.
6. **Symmetric, consistent UX.** MCP Hub and Skills Hub mirror each other; project integration behaves the same across features.

---

## 4. System architecture (high level)

### 4.1 Component model

- **Desktop shell** — cross-platform native app (recommended: Tauri or Electron; Tauri preferred for the ~200 MB footprint target and native performance). Windows: macOS 12+, Windows 10 1903+, Linux (Ubuntu 20.04+/Fedora 35+/Debian 11+), x64 + Apple Silicon.
- **Ingestion / parser layer** — per-tool adapters that read each tool's native log format:
  - Claude Code — JSONL files under `~/.claude/projects/`
  - Codex — JSONL under `~/.codex/`
  - Cursor — SQLite under workspace storage
  - Gemini CLI — JSON under `~/.gemini/`
  - GitHub Copilot Chat — global storage under the editor's config dir (VSCode/JetBrains, with distribution disambiguation)
  - OpenCode — SQLite DB (`opencode.db`)
- **Local datastore** — SQLite for parsed sessions, projects, metadata, MCP service config, security rules, interception logs. Skills stored as files under an app-data `skills/` directory.
- **Git snapshot engine** — reads project Git history, matches commits to conversation timestamps, extracts code at any point. Supports Git submodules.
- **Causality/analysis engine** — background AI tasks that link "reference blocks" (files the AI read) to code diffs with a confidence score.
- **MCP Hub server** — a Streamable-HTTP MCP server that aggregates upstream MCP services and enforces tool policies.
- **Security engine** — pattern-based detection + pre-tool-use interception.
- **Remote layer** — SSH/SFTP connection pool for remote import, browsing, and live watching.
- **System tray service** — keeps MCP Hub alive in the background.

### 4.2 Data flow (replay path)

1. User imports a project → parser reads native logs → normalized messages written to SQLite.
2. On opening a session, UI requests the message list + the associated physical path.
3. When a message is selected, the snapshot engine finds the nearest preceding Git commit and extracts that file tree/version.
4. UI renders the code panel (full content or diff) for that timestamp.

### 4.3 Key non-functional constraints

- App size target ~200 MB; ≥ 500 MB free disk; 4 GB min / 8 GB+ recommended RAM.
- Performance guardrails: degrade gracefully beyond ~5,000 messages/project; large single messages (>1 MB) and very large repos (>5 GB) may load slowly.
- Recommend ≤ 10 concurrently open projects.

---

## 5. Functional requirements by feature area

Each feature area below lists user stories and the requirements needed to reach parity. Requirements are labeled **FR-<area>-<n>**.

### 5.1 Import & onboarding

**User stories**
- As a new user, I can install and reach my first time-travel moment in under 5 minutes.
- As a user of multiple AI tools, I can import projects from any supported tool via a guided flow.

**Requirements**
- **FR-IMP-1** Provide installers for macOS (`.dmg` + Homebrew cask), Windows (`.exe`), Linux (`.deb`, `.rpm`, AppImage).
- **FR-IMP-2** An **Import Wizard** that lets the user pick a source tool (Claude Code, Cursor, Gemini CLI, Codex, GitHub Copilot Chat, OpenCode), then auto-scans standard log locations and lists importable projects with estimated session/message counts.
- **FR-IMP-3** Manual path selection ("Browse") for non-standard log locations.
- **FR-IMP-4** Import parses native logs into the local DB with a visible progress bar; target speeds: <100 msgs ~1–2 s, 100–500 ~2–5 s, >500 ~5–30 s.
- **FR-IMP-5** Flat, location-grouped import page: local sources at top, each remote server as its own group, plus "add server."
- **FR-IMP-6** Empty-state guidance for first launch; graceful handling of projects with no valid conversation data.

### 5.2 Time Travel (core replay)

**User stories**
- As a developer, I click any message and instantly see the exact code state at that moment.
- I can scrub a timeline like a video and jump between key events.

**Requirements**
- **FR-TT-1** Three-pane layout: **Mode Rail** (far left), **Conversation Panel** (center), **Code Snapshot Panel** (right), plus the timeline at the bottom.
- **FR-TT-2** Conversation panel: chronological message list with precise timestamps, message-type distinction (user / AI / tool / file / command / thinking / search), and current-position highlight.
- **FR-TT-3** Code snapshot panel: file tree (incl. Git submodule support), full file content, **Diff view** toggle (toolbar + shortcut `D`), change highlighting, multi-file switching.
- **FR-TT-4** Snapshot reflects code state *at the time of the conversation*, derived from Git history (nearest preceding commit), **not** current disk state.
- **FR-TT-5** **TimberLine timeline** controller with:
  - Colored tick marks — blue dot = user message, green square = Git commit, gray/transparent = AI/tool events.
  - Drag slider, hover-to-preview timestamp, click-to-jump.
  - Keyboard control when focused: `←`/`→` fine-tune (1% step), `Home`/`End` jump to start/end.
- **FR-TT-6** Timeline shows only in Playback Mode; hidden in Refine Mode.
- **FR-TT-7** Git prerequisites: project must be a Git repo with commit history; more frequent commits = higher fidelity. Provide clear empty-state guidance when Git repo/commits are missing.
- **FR-TT-8** Works in combination with Message Filtering (filter, then time-travel filtered results).

### 5.3 Replay Mode (Cognitive Replay)

**User stories**
- As a developer, I can re-execute the AI's operations step-by-step in a real file system to reconstruct or validate a solution, without risking my real project.

**Requirements**
- **FR-RP-1** **Deterministic replay** — replays operations from session history (create file, modify code, execute command) with **no LLM calls**.
- **FR-RP-2** **Step-by-step preview** — left pane shows AI reasoning/explanation; right pane shows the upcoming diff; user chooses "Execute This Step," "Skip," or "Look Back."
- **FR-RP-3** **Safety sandbox** — defaults to an isolated workspace at `{app_data_dir}/replay/{session_id}/`; original project untouched unless the user explicitly points the workspace at it (discouraged).
- **FR-RP-4** **Default workspace auto-creation** with a "Change" option to select a custom path before starting.
- **FR-RP-5** **Auto-play** with 1x / 2x / 5x speeds; auto-advances until error or manual pause.
- **FR-RP-6** **Fault tolerance** — on a failed step, log the reason and offer "Retry" or recover from the most recent stable checkpoint.
- **FR-RP-7** **Dangerous-command handling** — display full command text for `execute_command` steps; allow skip or environment confirmation before running.
- **FR-RP-8** "Open in Editor" on completion.

### 5.4 Project Management (Logical Projects)

**User stories**
- As a multi-tool user, I see all sessions for the same code repo unified, regardless of which AI tool produced them.

**Requirements**
- **FR-PM-1** **Logical Project** = aggregation of all sessions pointing to the same **physical path** (e.g., `/Users/x/projects/app`), across Claude Code, Cursor, Gemini CLI, Codex.
- **FR-PM-2** **Automatic aggregation** on import when physical paths match; project list shows source icons per project.
- **FR-PM-3** **Manual association / path correction** for tools that don't report accurate paths (e.g., Gemini `gemini-project:xxx` / "Needs Association"); auto-merge if a project already exists at that path.
- **FR-PM-4** **Rename** logical projects (display-name only; does not touch the folder).
- **FR-PM-5** **Unlink** a source from a logical project (source reverts to independent/virtual-path project).
- **FR-PM-6** **MCP service association + Tool Policies per project** (see 5.7) — Always Allow / Ask for Permission / Deny per tool.
- **FR-PM-7** **Git integration** — detect a Git repo at the physical path, show a Git icon, and expose Git status/history in-app.

### 5.5 Context Causality

**User stories**
- As a reviewer, I want to know *which referenced material* drove a given code change, not just that files were read.

**Requirements**
- **FR-CC-1** **Mentioned-files extraction** — parse file paths from tool calls (e.g., `read_file`) and list all files in the message header.
- **FR-CC-2** **Context promotion** — tool execution results (e.g., read file contents) are promoted to semantic "Reference Blocks."
- **FR-CC-3** **AI causality mapping** — background AI analysis links Reference Blocks to code diffs with confidence scoring: high (>0.8) shown as direct cause with strong visual association; low (<0.3) demoted to sidebar as background knowledge.
- **FR-CC-4** **Interactive experience** — hover a code change to illuminate its source material via lines/highlights; a "Context" icon opens the full data-dependency graph for a message.

### 5.6 MCP Hub (unified MCP control plane)

**User stories**
- As a platform engineer, I manage all MCP services and their permissions for every AI tool in one place.

**Requirements**
- **FR-MCP-1** **Aggregating MCP server** — implement the MCP standard, exposing a compliant **Streamable HTTP** endpoint that aggregates upstream services (stdio, SSE, and Streamable HTTP).
- **FR-MCP-2** **Configuration takeover** — one-click import of MCP configs from Claude Code, Cursor, Gemini CLI, Codex (user-level and project-level).
- **FR-MCP-3** **Smart merge engine** — classify imported entries as New / Updated / Conflict; provide diff comparison and manual resolution for conflicts; auto-backup before each takeover with atomic recovery.
- **FR-MCP-4** **Service management** — add/edit/toggle MCP services.
- **FR-MCP-5** **Environment variable management** — global and project-specific vars, with sensitive-value masking.
- **FR-MCP-6** **OAuth credential management** — securely store tokens for remote MCP services (e.g., Google Drive).
- **FR-MCP-7** **Status monitoring** — real-time hub status, connected clients, active services.
- **FR-MCP-8** **Project-level management (v0.8.2 parity)** — sidebar panel from project context menu; scoped config import; enhanced new-vs-existing detection.
- **FR-MCP-9** **Tool Policy** — per-project, per-tool enable/disable (e.g., `read_file`, `shell_execute`); Hub intercepts disallowed calls; "Strict Mode" exposes only project-relevant services; policies enforced even for native Claude Code via dynamic takeover.
- **FR-MCP-10** **MCP Roots protocol** — accept `roots/list` from tools and route to the correct services via Longest-Prefix-Match on working directory (no manual project switching).
- **FR-MCP-11** **Built-in MCP Inspector** — real-time JSON-RPC logs, manual tool invocation, troubleshooting for timeouts/permissions/format mismatches.
- **FR-MCP-12** **Backup & restore** — atomic operations, retain last 5 versions, integrity verification before restore, auto-cleanup of expired backups.
- **FR-MCP-13** **System tray integration** — background execution keeps the Hub alive when the main window is closed; tray quick-access to Hub/Inspector/quit; status notifications for exceptions/interceptions.
- **FR-MCP-14** **Streamable HTTP compliance (2025-03-26 spec)** — unified `/mcp` endpoint (POST/GET/DELETE), session management via `MCP-Session-Id` header, origin validation (CSRF protection), backward compatibility with legacy `/sse` and `/message`.

### 5.7 Skills Hub (unified Skills control plane)

**User stories**
- As a user of multiple AI tools, I manage a Skill once and have it available everywhere, and I can track its version history and upstream updates.

**Requirements**
- **FR-SK-1** **Central storage + symlink distribution** — Skills stored under `{app_data_dir}/skills/`, distributed to each tool's directory via symlinks (Linux/macOS) or junctions (Windows, no admin needed). All tools read the same file.
- **FR-SK-2** **Scan sources** — four standard tool dirs (Claude Code, Cursor, Codex, Gemini CLI; user- and project-level), custom source directories, and public GitHub repos.
- **FR-SK-3** **Four-tier classification** on scan — Auto Import / Auto Skip / Needs Decision / Broken.
- **FR-SK-4** **Multi-source aggregation** — the same real file referenced by several tools is shown as a single card with an "N references" badge, canonical source path, and expandable reference list; the wizard asks the user to decide only once.
- **FR-SK-5** **Broken-entry handling** — dangling symlinks / inaccessible dirs grouped separately with diagnostics; excluded from takeover.
- **FR-SK-6** **5-step import wizard** — Scan → Preview → Conflict Resolution → Execute → Link, with per-source progress feedback.
- **FR-SK-7** **Conflict resolution** — three-way comparison (Base/Ours/Theirs); Fast-Forward overwrite suggestion when local is unchanged; strategies Overwrite / Rename (`{name}-2`, `-3`…) / Skip (audit-logged); "apply to remaining conflicts" batch option.
- **FR-SK-8** **GitHub import** — public HTTPS repo URL, optional branch (default `main`) + subpath; shallow clone + auto-scan of all `SKILL.md` (100+ skills in <30 s); standard atomic takeover; records repo URL + commit SHA; "Check Upstream" compares and enters conflict flow; origin identification via `.git/config` + HEAD. (Private/SSH via OAuth token deferred.)
- **FR-SK-9** **Name disambiguation** — importing a duplicate name auto-suffixes; metadata fully inherited; provenance shown in detail panel.
- **FR-SK-10** **Management page** — overview metrics (total skills, linked projects, backup status), tag filtering (auto tool-brand tags), full-text search across name/description/tags, list/grid toggle, sort by rating/name/date, collapsible backup summary.
- **FR-SK-11** **Tags & 1–5★ ratings** — tags feed search + filter; ratings usable as sort dimension; all stored locally, never uploaded.
- **FR-SK-12** **Skill detail** — full metadata, content preview, tags/rating, linked projects, version history timeline, deletion-impact preview.
- **FR-SK-13** **Version history & snapshots** — auto triggers: `imported` (permanent), `fs_change` (500 ms debounce, rolling cleanup after 50), `upstream_sync`, `restore`; identical-hash dedup; timeline columns (time/source/size/hash/actions); restore with confirmation, auto `restore` snapshot, symlink preserved; capacity limits (≤50 non-imported snapshots/skill; warnings at 100 MB/skill and 2 GB total).
- **FR-SK-14** **Takeover safety** — four-step atomic op with dual-branch rollback (BACKUP → COPY → CLEANUP → SYMLINK); backups retain last 5, integrity-verified; two-level external-source warnings (amber = under HOME outside tool dirs → cleaned + backed up to `~/.chronicle/backups/`; red = system path → not cleaned, copy only); confirmation checkbox before external cleanup; safety allowlist restricts cleanup to `$HOME/`.
- **FR-SK-15** **Project linking** — many-to-many; user-level skills auto-link to all projects, project-level to source project; manual link/unlink updates symlinks; SkillContextCard embedded in project detail (counts, source icons, expandable list, search box beyond 5, bidirectional navigation).
- **FR-SK-16** **Reverse-flow detection** — detect skills created directly by tools (bypassing management) and offer a one-click import banner.
- **FR-SK-17** **Custom source directories** — managed in Settings → Developer Settings; default `~/.agents/skills/` (AGENTS.md convention) enabled by default and non-deletable; path validation (must exist; block system-sensitive paths and HOME-sensitive dirs like `.ssh`/`.aws`/`.kube`; allow non-HOME dirs); enable/disable/delete + status indicators; read-only scan sources (symlink fanout still only writes the four standard tool dirs).

### 5.8 Session Live Streaming

**User stories**
- As a developer, I can open an in-progress session and watch new messages appear in real time, like a livestream.

**Requirements**
- **FR-LS-1** **Live watch by source** — Claude Code & Codex via JSONL incremental reads; Cursor via read-only SQLite periodic polling; Gemini CLI via JSON re-parse with diff-against-last-state.
- **FR-LS-2** **Auto-detection** — activate live watching automatically when a session file has recent writes.
- **FR-LS-3** **Live rendering** — new messages fade in; auto-scroll when at bottom; a floating "N new messages" button when scrolled up.
- **FR-LS-4** **Status indicator** — Live (green) / Stopped (paused, click to reconnect) / Reconnecting.
- **FR-LS-5** **Auto error recovery** — exponential backoff (up to 3 retries), manual reconnect fallback, idle detection to lower polling frequency.
- **FR-LS-6** **Handles appends, tool calls/results, and unparseable content** (skip and continue).
- **FR-LS-7** **Auto-stop** on normal session end, session switch/close, or background mode (reduced frequency).
- **FR-LS-8** **Remote live streaming** (see 5.9) — `tail -f`-style JSONL streaming for Claude Code/Codex, remote SQLite queries for Cursor, remote JSON polling for Gemini; resume from last offset after reconnect.
- **FR-LS-9** **Performance** — incremental reads only, read-only polling, connection reuse; minimal footprint.

### 5.9 Remote SSH Access

**User stories**
- As a remote developer, I can import, browse, and live-watch sessions running on a remote server without installing anything there or downloading logs.

**Requirements**
- **FR-SSH-1** **Zero-config connection** — read `~/.ssh/config` to discover hosts; support key file, SSH Agent forwarding, and password auth with automatic fallback; save successful connections sorted by last-used.
- **FR-SSH-2** **Remote source auto-detection** — scan standard paths per tool (Claude `~/.claude/projects/`, Codex `~/.codex/`, Cursor `~/.config/Cursor/`, Gemini `~/.gemini/`) and show estimated session counts.
- **FR-SSH-3** **Remote import with no local file storage** — SFTP streaming for JSONL/JSON (Claude/Codex/Gemini), remote command execution for Cursor SQLite; parse directly into local DB.
- **FR-SSH-4** **Remote file browsing** — list dirs via SFTP, open any file, memory-cache frequent files; identical file-tree UX to local.
- **FR-SSH-5** **Connection pool & keepalive** — channel multiplexing over one connection, keepalive messages, graceful recovery with a 60-second grace period.
- **FR-SSH-6** **Jump hosts** — support `ProxyJump` / bastion routing from `~/.ssh/config`.
- **FR-SSH-7** **Remote project sync** — "Sync" scans for new sessions/updates without full re-import; auto-reconnect and continue.
- **FR-SSH-8** **Security** — never store SSH passwords; never read key content (use system SSH library); access only necessary data; **all remote operations read-only**; first-connection host-key fingerprint verification.
- **FR-SSH-9** **Multi-server** — connect to multiple servers simultaneously, each with an independent connection pool.

### 5.10 Modes

The app has four modes, switchable via the Mode Rail and `Cmd/Ctrl+1/2/3` (+ Replay).

- **FR-MODE-1 Analytics Mode** — project-level statistics: overview metrics (session count, total duration, active days, error rate), activity trend chart, tool-call distribution (Edit/Write/Bash/Read…), project↔session granularity toggle.
- **FR-MODE-2 Playback Mode (default)** — full timeline (TimberLine), code snapshots, diff view, full unfiltered context.
- **FR-MODE-3 Refine Mode (Compact)** — context optimization / knowledge distillation: distraction-free split pane (original left, preview/edit right), message operations Keep/Delete/Edit/Insert, real-time token stats, full undo/redo. Shortcuts: `K` keep, `D` delete, `E` edit, `I` insert, `Cmd/Ctrl+S` export, `?` help, `Cmd/Ctrl+Z` undo. Export a cleaned session as documentation or as a prompt for a new task.
- **FR-MODE-4 Replay Mode** — see 5.3.
- **FR-MODE-5 Mode Rail** — 4 mode icons (each accent-colored, active shown with a colored left bar + tinted icon) + 3 utility buttons (Hub / Skills / Settings).

### 5.11 Message Filtering & Search

**User stories**
- As a developer, I can quickly find the message I need in a session with hundreds of turns.

**Requirements**
- **FR-FLT-1** **Type filtering** — multi-select chips for Conversation / Tool / File / Command / Thinking / Search; OR logic across selected types; real-time match stats (e.g., "Match: 15/200").
- **FR-FLT-2** **Smart tool pairing** — selecting "Tool" always shows request + result together, never orphaned.
- **FR-FLT-3** **Keyword search** — `Cmd/Ctrl+F`; case-insensitive; partial match (`auth` → `authentication`, `OAuth`); 300 ms debounce; `Esc`/`X` to clear.
- **FR-FLT-4** **Combined search** — type filter AND keyword (e.g., File + "auth").
- **FR-FLT-5** **Search result navigation** — click a (global/sidebar) result to smoothly scroll-center on the target message; focused message shows a blue left border + pulsing glow; other matches show subtle markers; in-message keyword highlight in yellow (code/thinking blocks excluded); multi-match navigator (keyword, "2/5" counter, prev/next with wrap); shortcuts `Enter` next, `Shift+Enter` prev, `Esc` clear.
- **FR-FLT-6** **Non-destructive** — filtering only changes the displayed list; timeline, time-travel, and code snapshots are unaffected. "Clear Filter" resets all conditions.

### 5.12 Security: One-Click Security Check & Redaction

**User stories**
- As a contributor, I can guarantee no secrets leak before I share a session, and I'm protected in real time during a session.

**Requirements**
- **FR-SEC-1** **Built-in detection rules** (no config needed) for: API keys (`sk-`, `anthropic-` prefixes → `sk-****`), passwords (after `password`/`pwd` → `****`), tokens (`Bearer`, `eyJ` → `eyJ****`), personal info (emails/phones → `***@***.com`), DB credentials/connection strings (→ `****`), private addresses (intranet IPs / private domains → `***.***.***`).
- **FR-SEC-2** **Custom rules** — user-defined via Settings → Security Check Rules using glob-style patterns (`*` any length, `?` single char), e.g., `PROJECT-*`, `*@company.com`, `Internal-???`; add/edit/delete; note that deleting a built-in rule disables that detection.
- **FR-SEC-3** **Rule priority** — custom over built-in, more-specific over broader, later-added over earlier; support "keep/allowlist" exceptions.
- **FR-SEC-4** **Preview mode** — "Security Check" button shows detected sensitive content highlighted alongside redacted output; scroll to verify; add/adjust/temporarily-disable rules and re-preview.
- **FR-SEC-5** **Real-time protection (Pre-Tool-Use detection)** — before tool content (e.g., `read_file`) is sent to the model, scan it; on detection: auto-intercept, show reason in chat, and (if user proceeds) send only redacted content.
- **FR-SEC-6** **Interception records** — sidebar log of all interception events with timestamp, file path, matched rules, and blocked content, for rule tuning.
- **FR-SEC-7** **One-way redaction** — redaction can't be reversed in the shared copy; local original data is never modified; meaningful placeholders preserve readability and structure (code blocks/lists intact).
- **FR-SEC-8** **Safe sharing** — after preview, share via generated link (default 7-day validity, view counts in Share Management) or exported redacted file. Recommend shorter validity for sensitive projects. (Bulk redaction across projects is deferred; workaround is shared rule set.)

### 5.13 Analytics

Covered by Analytics Mode (FR-MODE-1). Additional:
- **FR-AN-1** Quantify AI-assisted productivity and usage patterns; compare depth across projects; surface high-frequency tool-call patterns to inform prompt strategy.

### 5.14 Cross-cutting: Compatibility matrix

**FR-COMPAT-1** Support the following tools and features at GA (parity target):

| Feature | Claude Code | Gemini CLI | Cursor | Codex | Copilot Chat | OpenCode |
| --- | --- | --- | --- | --- | --- | --- |
| Conversation import | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Time Travel / Code snapshots | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Replay Mode | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Message filtering | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Content redaction | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool call viewing | ✅ | ⚠️ partial | ✅ | ✅ | ✅ | ✅ |
| Context Causality | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Git history matching | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Real-time sync / live streaming | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MCP Hub takeover | ✅ | ✅ | ✅ | ✅ | – | – |
| Skills Hub takeover | ✅ | ✅ | ✅ | ✅ | – | – |
| Remote SSH access | ✅ | ✅ | ✅ | ✅ | ✅ | 🔜 |

Legend: ✅ full · ⚠️ partial · 🔜 planned · – not applicable.

**FR-COMPAT-2** Known-limitation handling: degrade gracefully beyond ~5,000 messages/project (offer time-period views); tolerate incompatible/old log formats with clear messaging; support Git submodules; handle non-standard/custom log paths via manual selection.

---

## 6. Non-functional requirements

- **NFR-1 Local-first & offline.** All core features work with no network. No mandatory account.
- **NFR-2 Privacy.** No session content leaves the machine except via explicit user-initiated share; ratings/skills data never uploaded.
- **NFR-3 Cross-platform.** macOS 12+ (Intel + Apple Silicon), Windows 10 1903+ (x64), Linux (Ubuntu 20.04+/Fedora 35+/Debian 11+, x64); AppImage for portability.
- **NFR-4 Footprint.** ~200 MB app; ≥ 500 MB disk; 4 GB min / 8 GB+ recommended RAM.
- **NFR-5 Performance.** Import targets per §1.5; live-stream latency < 1 s; SSD strongly recommended.
- **NFR-6 Reliability.** Atomic backup/restore for MCP + Skills takeovers with rollback; integrity verification; single-instance lock.
- **NFR-7 Updatability.** Built-in auto-updater with incremental/background downloads.
- **NFR-8 Security posture.** Read-only on remote systems; SSH secrets never stored; system paths never cleaned; one-way redaction.
- **NFR-9 Internationalization.** At least English + one additional locale (Chronicle ships English + Simplified Chinese); build i18n in from the start.
- **NFR-10 Accessibility & keyboard-first.** Comprehensive keyboard shortcuts across modes.

---

## 7. Phased roadmap

Ordered to reach the "aha" moment fastest, then layer control-plane and advanced capabilities. (Mirrors Chronicle's own release history as a proven sequence.)

**Phase 1 — Replay MVP.** Import wizard (Claude Code + one more tool), SQLite datastore, Git snapshot engine, Playback Mode, Time Travel + TimberLine, code/diff panel, basic message list. *Goal: <5-min time-travel on a real session.*

**Phase 2 — Navigation & multi-source.** Message Filtering + global search + result navigation; Logical Project aggregation (auto + manual association, rename, unlink); Analytics Mode; broaden tool support (Cursor, Gemini, Codex).

**Phase 3 — Security & refinement.** One-Click Security Check (built-in + custom rules, preview, sharing); Refine Mode (Keep/Delete/Edit/Insert, token stats, export); pre-tool-use interception + interception records.

**Phase 4 — Control plane.** MCP Hub (takeover, aggregating Streamable-HTTP server, tool policies, env vars, OAuth, Inspector, MCP Roots, tray, backup/restore); project-level MCP; Skills Hub (central storage + symlink distribution, import wizard, conflict resolution, GitHub import, version history, project linking); auto-updater.

**Phase 5 — Live & remote & causality.** Session Live Streaming (local + remote); Remote SSH Access (import/browse/live, jump hosts, sync); Replay Mode (deterministic step replay, sandbox, auto-play, fault recovery); Context Causality. Copilot Chat + OpenCode support.

**Phase 6 (future / non-goals for parity).** Team collaboration, optional encrypted cloud sync, AI analysis reports, plugin/extension system, more tools (Windsurf, Codeium).

---

## 8. Open questions & decisions to make

1. **Desktop framework.** Tauri (smaller footprint, Rust core) vs Electron (faster ecosystem velocity). *Recommendation: Tauri to hit the ~200 MB target.*
2. **Causality engine model.** Which model powers background causality analysis, and does it run fully locally (to preserve offline guarantee) or optionally via API? Local-first suggests an on-device/small model with an opt-in cloud upgrade.
3. **Share links.** Chronicle's share links imply *some* hosting. Do we build an in-house share service, or ship export-file-only for v1 to preserve zero-backend?
4. **Snapshot fidelity vs. commit frequency.** Should we offer an optional auto-commit/shadow-Git mechanism so replay fidelity doesn't depend on user commit discipline?
5. **Licensing / build-vs-adopt.** Chronicle's core is free; confirm whether an in-house build is warranted vs. adopting/extending, given the substantial control-plane surface area.
6. **Enterprise deployment.** Network proxy support and managed deployment are referenced by Chronicle — are these in scope for our internal rollout?

---

## 9. Decision log (post-implementation)

Resolutions to §8's open questions, plus status as of v0.1.0 (2026-07-06):

1. **Desktop framework → Electron.** No Rust toolchain on the dev machine; Electron ships today. The server layer has zero Electron imports, so the Tauri migration path stays open. Footprint is ~116 MB DMG (within tolerance of the ~200 MB target).
2. **Causality engine → local heuristics, no LLM.** Confidence tiers (0.95 read-this-exact-file → 0.2 background context) computed from tool-call structure. Preserves the offline guarantee with zero cost; an opt-in model upgrade remains possible.
3. **Share links → in-house, zero-backend.** Served by the local app at `/share/<token>` with the redacted copy frozen at creation. No hosting dependency.
4. **Shadow-Git / auto-commit → not built.** Replay fidelity depends on user commit discipline; revisit if it becomes a real pain point.
5. **Build-vs-adopt → built in-house.** Full parity surface achieved in-house (see status below); control-plane behavior (additive-only skills distribution, local share links) deliberately diverges from Chronicle where safety demanded it.
6. **Enterprise deployment → out of scope** for the personal rollout; unaddressed.

**Implementation status:** Phases 1–5 complete except **remote SSH (§5.9)** — all 6 tool importers, time travel, Replay, Refine, Overview + mode rail, filtering, analytics, live streaming (JSONL + SQLite polling), security (redaction, pre-tool-use hook, share links), MCP Hub, Skills Hub, i18n (EN/zh-CN), Electron desktop shell. **FR-IMP-1** is partial: macOS `.dmg` (arm64 + x64) + Homebrew cask shipped; Windows/Linux installers, code signing/notarization, and silent auto-update (NFR-7) pending. Context-window accounting was added beyond the PRD: real per-session token usage parsed from Claude Code usage records, with a usage bar against each model's context window.

---

## Appendix A — Source references

All requirements are derived from Chronicle's public site and documentation (read 2026-07-03):

- Home — https://chronicle.example/#features
- Docs home — https://docs.chronicle.example/en/
- Getting Started — https://docs.chronicle.example/en/guide/getting-started.html
- Time Travel — https://docs.chronicle.example/en/features/time-travel.html
- Replay Mode — https://docs.chronicle.example/en/features/replay.html
- Project Management — https://docs.chronicle.example/en/features/project-management.html
- Context Causality — https://docs.chronicle.example/en/features/context-causality.html
- MCP Hub — https://docs.chronicle.example/en/features/mcp-hub.html
- Skills Hub — https://docs.chronicle.example/en/features/skills-hub.html
- Session Live Streaming — https://docs.chronicle.example/en/features/live-streaming.html
- Remote SSH Access — https://docs.chronicle.example/en/features/remote-ssh.html
- Modes — https://docs.chronicle.example/en/features/modes.html
- Message Filtering — https://docs.chronicle.example/en/features/filtering.html
- Content Redaction — https://docs.chronicle.example/en/features/redaction.html
- Compatibility — https://docs.chronicle.example/en/reference/compatibility.html
