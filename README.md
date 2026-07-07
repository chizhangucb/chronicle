# Chronicle — AI Session Time Machine

Local-first session manager for AI coding assistants. Import conversation logs from
**Claude Code, Codex, Cursor, OpenCode, Gemini CLI, and GitHub Copilot Chat**, then
click any message to **time-travel** to the exact code state at that moment —
reconstructed from your project's Git history. Everything runs on your machine:
no LLM calls, no cloud, source logs and project repos are never written to.

Built from [the PRD](docs/AI-session-manager-PRD.md). Design doc:
[docs/superpowers/specs](docs/superpowers/specs/2026-07-03-chronicle-phase1-design.md).

## Install (macOS)

**Homebrew:**

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle --no-quarantine
```

**Or download the DMG** from [Releases](https://github.com/chizhangucb/chronicle/releases)
(arm64 for Apple Silicon, x64 for Intel). The app is not yet code-signed, so
`--no-quarantine` (or `xattr -dr com.apple.quarantine "/Applications/Chronicle.app"`
after installing) is needed to skip the Gatekeeper warning.

Windows / Linux installers: not built yet — run from source below.

## Run from source

```bash
npm install
npm run dev        # dev server → http://localhost:4173
npm run desktop    # desktop app (Electron shell + tray, port 41730)
npm run standalone # headless production server (API + UI + /mcp)
npm run dist:mac   # build macOS DMGs (arm64 + x64) into release/
```

Click **Import Sessions**, pick a source tool, and open a session.

## What's implemented

- **Import wizard** — 4-step flow (Select Source → Select Files → Importing →
  Complete) scanning all 6 tools' standard log locations: `~/.claude/projects/`
  (Claude Code), `~/.codex/sessions/` (Codex), Cursor `workspaceStorage`, OpenCode's
  `opencode.db`, `~/.gemini/tmp/`, and VS Code `chatSessions` (Copilot).
  **Session-level selection** with NEW / Partial / Imported badges, auto-select of
  new sessions, search, rescan, and manual directory scan. Imports are read-only into
  a local SQLite DB (`~/.chronicle/chronicle.db`); SQLite sources are copied to temp
  (incl. WAL) before reading — foreign databases are never opened live.
- **Session Overview** (`⌘1`, the session home page) — duration / messages / tool
  calls / errors / context stat cards, a **context-window usage bar** (real token
  usage from the log's API usage records vs. the model's context window, colored
  cyan → yellow → red as it fills), call timeline, tool-distribution donut, per-call
  ✓/✗ details, and a danger zone to delete the source log file, the Chronicle copy,
  or both (two-step confirm).
- **Mode rail** — Overview / Playback / Refine / Replay / Security on the left edge
  (`⌘1`–`⌘4`), Chronicle-style.
- **Logical projects** — sessions from all tools aggregate by physical project path;
  Git badge, source icons.
- **Playback Mode** — three-pane layout: typed message list (user / AI / thinking /
  tool call / tool result), code snapshot panel, TimberLine timeline.
- **Time travel** — selecting a message resolves the nearest preceding Git commit and
  renders the file tree + file contents *as they were at that moment*. Changed files
  are green-dotted and auto-selected.
- **Diff view** — toolbar toggle or `D`; shows the selected file vs. its previous
  committed version with compressed unchanged context.
- **TimberLine** — blue dots = user messages, green squares = commits, gray ticks =
  AI/tool events. Click/drag to seek, hover for timestamp, `←`/`→` fine-tune (1%),
  `Home`/`End` jump. Seeking selects the nearest message and updates the snapshot.
- **Filtering & search** — Conversation / Tool / Thinking chips (OR logic, tool
  request+result pairing), `⌘F` keyword search (300 ms debounce, highlight, match
  counts), combined filters, non-destructive.
- **Analytics (lite)** — per-project sessions, message counts, active days, tool-call
  distribution, activity sparkline.
- **Refine Mode** (`⌘3`) — distill a session into documentation or a reusable prompt:
  original messages left, **Compressed Preview** right (Full / Changes Only /
  Hide Deleted views); Keep/Delete/Edit/Insert (`K`/`D`/`E`/`I`) with per-message
  token badges; status bar with undo/redo/reset (`⌘Z`/`⇧⌘Z`), Original → Compressed →
  Saved token stats, and an Export menu (Markdown / as Prompt, `⌘S`). Tool results
  and thinking start pre-deleted as noise — press `K` to keep the ones that matter.
- **Security Check** — one-click scan with built-in rules (API keys, passwords,
  Bearer/JWT tokens, emails, phones, DB connection strings, private IPs — 13/13 recall
  on seeded secrets), custom glob rules (`KITE-*`, `*@company.com`) with allow-list
  exceptions and priority (custom > built-in, specific > broad), side-by-side
  detected-vs-redacted preview, and one-way redacted markdown export. Originals are
  never modified.

- **MCP Hub** — a real aggregating MCP server at `http://localhost:4173/mcp`
  (Streamable HTTP, 2025-03-26 spec: `MCP-Session-Id`, origin validation, POST
  JSON-RPC). Point any AI tool at it and every upstream service (stdio child
  processes + remote HTTP) appears as namespaced `service__tool` tools. Includes
  one-click **config takeover** from Claude Code / Cursor / Gemini / Codex configs
  (New/Updated/Conflict classification, auto-backup to `~/.chronicle/backups/mcp/`,
  sources never rewritten), per-service enable/disable, masked secrets, live status,
  and a built-in **Inspector** (JSON-RPC log + manual tool invocation).
- **Skills Hub** — scans `~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`
  etc., parses `SKILL.md` frontmatter, imports into central storage at
  `~/.chronicle/skills/`, and distributes via symlinks to tool directories.
  Strictly additive: it never overwrites a real skill directory and only removes
  symlinks it created. Cards with search, local-only tags/ratings, link status per
  tool, and a detail view.

- **Live streaming** — sessions whose log file was written in the last 5 minutes
  auto-activate a live tail (incremental JSONL reads → SSE). New messages fade in,
  auto-scroll when at the bottom, a floating "N new messages" button otherwise;
  ● LIVE / Reconnecting / Stopped indicator with exponential-backoff recovery and
  idle slow-down. Watchers stop automatically when the viewer closes.
- **Replay Mode** (`⌘4`) — deterministic re-execution of a session's Write / Edit /
  Bash operations in an isolated sandbox at `~/.chronicle/replay/<id>/`, seeded from
  the Git snapshot at session start. Step-by-step with the AI's reasoning and an
  upcoming-diff preview; Execute / Skip / Look Back; auto-play at 1x/2x/5x that
  pauses on errors; shell commands always require explicit per-step confirmation
  and run with the sandbox as cwd. No LLM calls; the real project is never touched.

- **Context Causality** — local heuristic analysis (no LLM) links what the AI *read*
  to what it *changed*: ⛓ badges on Write/Edit messages open a panel of source
  reference blocks with confidence scores (95% read-this-exact-file → 20% background
  context); click a source to jump to it.
- **Gemini CLI import** — parses `~/.gemini/tmp/<hash>/` logs + saved chats; Gemini
  doesn't record real project paths, so imports land as "Needs association" and a
  one-click banner merges them into the right project.
- **Project management** — per-card gear menu (Sync Update / View Details / Rename /
  Remove from Chronicle), unlink a source into its own project, manual path
  association with auto-merge. Session cards show real context usage (`⧉ 530k ctx`).
- **Tool policies** — per-service ⛭ policy panel in the MCP Hub; unchecked tools are
  hidden from `tools/list` and blocked on `tools/call` (logged as interceptions).

- **Real-time protection (pre-tool-use interception)** — `hooks/chronicle-guard.mjs`
  is a Claude Code `PreToolUse` hook: before Read/Grep/Bash/WebFetch runs, Chronicle
  scans the tool content (including actual file contents for Read). High-risk secrets
  (API keys, passwords, tokens, DB credentials) block the call with an explanation;
  lower-risk matches are flagged. All events land in Security → Interception records.
  One-click installer (backs up `~/.claude/settings.json` first); fails open if
  Chronicle isn't running.
- **Share links** — 🛡 Security Check → "Create share link" mints a tokenized URL
  (default 7-day validity) served by the local app. The share stores a redacted copy
  frozen at creation — originals never leave the machine. Security → Share management
  lists links with view counts and immediate revocation.
- **Copilot Chat import** — parses VS Code `workspaceStorage/<hash>/chatSessions/`
  (stable/Insiders/VSCodium), completing the 6-tool compatibility matrix.

- **Live polling for SQLite sources** — Cursor/OpenCode sessions live-stream via
  read-only periodic re-parse (temp-copy snapshots, WAL-aware mtime checks).
- **Skills: GitHub import & version history** — shallow-clone a public repo, scan all
  `SKILL.md` dirs, import with commit SHA recorded; "Check upstream" via `ls-remote`;
  automatic snapshots (`imported` permanent, `fs_change` 500 ms-debounced, rolling 50)
  with hash dedup and one-click restore.
- **MCP Roots + credentials** — services can be scoped to a project path; the hub
  routes `tools/list` by longest-prefix-match on the client's root (header or
  `initialize` rootUri). Per-service bearer credentials stored locally, always masked.
- **i18n** — English + 简体中文, dropdown in the top bar.
- **Performance guardrails** — windowed message rendering (400 around selection) and
  timeline tick decimation; a 6,000-message session renders 400 DOM rows.
- **Desktop shell** — Electron app (`npm run desktop`): embedded production server,
  system tray that keeps the MCP Hub alive when the window closes, single-instance
  lock, and a release-feed update check. (Tauri migration path intact — the server
  layer has no Electron dependency. Silent auto-update needs a signing pipeline.)

## Architecture

```
server/            Express API, mounted inside the Vite dev server (one process)
  db.js            node:sqlite datastore (~/.chronicle/chronicle.db)
  parsers/         claudeCode, codex, cursor, opencode, gemini, copilot
                   → normalized event model
  git.js           read-only Git snapshot engine (rev-list / ls-tree / show)
  api.js           REST: /api/scan /import /projects /sessions /git/*
  live.js          JSONL tail + SQLite polling → SSE
  mcp/             service registry + aggregating hub at /mcp
  security.js      redaction rules, session scan, pre-tool-use checks
  skills.js        central skill store, symlink fanout, GitHub import
src/               React UI (Vite) — plain React + one styles.css
electron/          desktop shell (tray, single instance, update check)
hooks/             chronicle-guard.mjs — Claude Code PreToolUse hook
```

All data stays on this machine. Source logs and project repos are never written to.

## Remaining (per [PRD](docs/AI-session-manager-PRD.md))

Remote SSH access (import / browse / live-watch over SSH) · Windows + Linux
installers · code signing + notarization and silent auto-update · destructive
skills takeover · OAuth browser flow for MCP credentials. Everything else in the
PRD's GA scope is implemented — see the
[decision log in the PRD](docs/AI-session-manager-PRD.md#9-decision-log-post-implementation).

## License

[MIT](LICENSE)
