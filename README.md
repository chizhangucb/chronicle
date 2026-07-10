# Chronicle — AI Session Time Machine

Local-first session manager for AI coding assistants. Import conversation logs from
**Claude Code, Codex, Cursor, OpenCode, Gemini CLI, and GitHub Copilot Chat**, then
click any message to **time-travel** to the exact code state at that moment —
reconstructed from your project's Git history. Everything runs on your machine:
no LLM calls, no cloud, source logs and project repos are never written to.

Built from [the PRD](docs/AI-session-manager-PRD.md). Full docs:
**[getchronicle.dev/docs](https://getchronicle.dev/docs)**.

## Install (macOS)

**[Download from getchronicle.dev](https://getchronicle.dev)** — one button, auto-detects
Apple Silicon vs Intel. Builds are **signed with an Apple Developer ID and notarized**, so
they open with no Gatekeeper warning — no `--no-quarantine` needed.

**Or install with Homebrew:**

```bash
brew tap chizhangucb/chronicle
brew install --cask chronicle
```

After install, Chronicle **keeps itself up to date**: when a new signed release ships it
downloads in the background and shows a one-click **Relaunch to update**.

Windows / Linux installers: not built yet — run from source below.

## Run from source

```bash
npm install
npm run dev        # dev server → http://localhost:4173
npm run desktop    # desktop app (Electron shell + tray, port 41730)
npm run standalone # headless production server (API + UI + /mcp)
npm run dist:mac   # build macOS DMGs (arm64 + x64) into release/
npm run reinstall:mac # rebuild (arm64), replace /Applications/Chronicle.app, clean release/
```

Click **Import Sessions**, pick a source tool, and open a session.

## What's implemented

Full details for every feature live at **[getchronicle.dev/docs](https://getchronicle.dev/docs)**.
The highlights:

### Import & projects
- **6-tool import** — Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Copilot Chat via a guided wizard; read-only into a local SQLite DB (WAL-safe temp copies, originals never touched).
- **Logical projects** — sessions from every tool aggregate by repo path; manual association, unlink, per-session sync, live Git badge.
- **Session overview** — per-session stats with **Active Duration** (real working time), a **Cost & Usage** panel (local token→$ from Anthropic list prices), and a context-window bar.

### Replay & time travel
- **Time travel** — click any message to see your code exactly as it was, rebuilt from Git history (Playback mode).
- **Diff & TimberLine** — file diffs against the previous commit plus a scrubbable timeline of messages and commits.
- **Replay mode** — deterministic re-run of Write/Edit/Bash steps in a sandbox; no LLM calls, the real project is never touched.
- **Refine mode** — distill a session into docs or a reusable prompt (Keep/Delete/Edit/Insert, token stats, Markdown export).
- **Context causality** — heuristic links from what the AI *read* to what it *changed*, with confidence scores.

### Search & insights
- **Filtering & search** — type chips and `⌘F` within a session; a `⌘K` global full-text command palette across all sessions.
- **Analytics** — per-project sessions, active days, tool-call distribution, and Today / 7 / 30 / 365-day ranges.

### Control plane
- **MCP Hub** — a real aggregating Streamable-HTTP MCP server: one-click config takeover, per-tool policies, project roots, and a built-in Inspector.
- **Skills Hub** — central skill store with symlink fanout to every tool; GitHub import, version history, strictly additive.

### Security & sharing
- **Security Check** — built-in and custom redaction rules with a detected-vs-redacted preview and one-way redacted export.
- **Real-time protection** — a Claude Code PreToolUse hook that blocks secrets before Read/Grep/Bash/WebFetch run.
- **Share links** — tokenized, redacted, served by the local app; view counts and instant revocation.

### Live & platform
- **Live streaming** — auto-tail in-progress sessions (JSONL reads + read-only SQLite polling → SSE) with auto-reconnect.
- **Desktop shell** — Electron app with a system tray and **signed auto-update** (notarized builds, one-click relaunch).
- **i18n** — English · 简体中文 · 日本語.
- **Performance** — windowed rendering and timeline decimation keep 6,000-message sessions fast.
- **Feedback** — in-app, via a hosted relay; logged locally first, no secrets in the app.

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
installers · destructive skills takeover · OAuth browser flow for MCP credentials.
Code signing + notarization and one-click auto-update **shipped in v0.1.6**; the rest
of the PRD's GA scope is implemented — see the
[decision log in the PRD](docs/AI-session-manager-PRD.md#9-decision-log-post-implementation).

## Support Chronicle

Chronicle is free and 100% open-source. If it saves you time, you can sponsor its
development — one-time or monthly. Payments are handled entirely by each provider;
nothing touches Chronicle.

- **[GitHub Sponsors](https://github.com/sponsors/chizhangucb)** — card, one-time or monthly (0% fee).
- **[Lemon Squeezy](https://chronicle.lemonsqueezy.com/buy/one-time)** — card, PayPal & Venmo (Alipay & WeChat one-time too).
- **[爱发电 Afdian](https://afdian.com/a/chronicle)** — 支付宝 / 微信 (Alipay / WeChat), one-time (投喂) or monthly (包月).

## License

[MIT](LICENSE)
