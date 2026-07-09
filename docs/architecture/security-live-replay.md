# Security, Live Streaming, Replay & Causality

The four subsystems that make Chronicle feel "smart" — secret redaction, live session tailing, deterministic replay, and read→change causality — are all **local heuristics**. There are no LLM calls anywhere in this stack, which is exactly what preserves the offline-by-default guarantee.

This page covers `server/security.js`, `hooks/chronicle-guard.mjs`, `server/live.js`, `server/replay.js`, `server/causality.js`, and `server/shares.js` for contributors. Each section explains the data flow and the design constraint it satisfies. The common thread: every "intelligent" behavior here is pattern-matching and structural analysis you could read and audit, not a model you have to trust.

## Security engine (`server/security.js`)

The redaction engine turns text into `{ findings, redacted }`. It combines a fixed set of built-in detectors with user-defined glob rules, resolves overlaps by priority, and never touches the original data — redaction is one-way and applied only to copies.

### Built-in rules

`BUILTIN_RULES` is an ordered array of regex detectors that need no configuration:

| Rule id | Detects | Example redaction |
| --- | --- | --- |
| `api_key` | `sk-…`, `anthropic-…`, `AKIA…`, `ghp_…`, `xox…`, `AIza…` | `sk-****` |
| `password` | `password`/`secret` = value | keeps the key, masks the value |
| `token` | `Bearer …`, JWTs (`eyJ…`) | `eyJ****` |
| `db_conn` | `postgres://`, `mysql://`, `mongodb://`, … | `****` |
| `email` | email addresses | `***@***.com` |
| `phone` | phone numbers | `***-***-****` |
| `private_ip` | `10.*`, `127.*`, `192.168.*`, `172.16–31.*` | `***.***.***.***` |

Order matters: `db_conn` deliberately runs before `email`/`password` so a connection string is redacted as a whole rather than shredded into an email match plus a password match (this is the "specific before broad" rule, baked into array order).

### Custom rules and priority

Custom rules are **globs** — `*` matches any run of non-whitespace, `?` a single char — compiled to regex by `globToRegex()`. A rule is either a `redact` rule (`KITE-*`, `*@company.com`) or an `allow` rule that protects a span from redaction. `scanText()` resolves everyone competing for the same characters with a fixed priority:

1. **Allow-list wins.** Any span matched by an `allow` rule is protected first and can never be redacted.
2. **Custom `redact` rules before built-ins.** They're spliced ahead of `BUILTIN_RULES` in the rule set.
3. **Earlier match wins on overlap.** A `claimed` interval list means once a span is redacted, a later rule can't re-claim overlapping characters.

The result is deterministic: findings are sorted by position and the redacted string is rebuilt by splicing replacements over the claimed spans. Exports: `listRules`, `addRule`, `deleteRule`, `toggleRule`, `scanText(text)`, `scanSession(messages)`, `preToolUseCheck(...)`, `listInterceptions`.

`scanSession(messages)` is the batch path used by the Security Check and by share creation: it scans each message's `text` and `tool_input`, returns per-message findings plus redacted copies, and aggregates a `totals` histogram and `findingCount`.

### The pre-tool-use path

`preToolUseCheck({ tool_name, tool_input }, readFileFn)` is the live-guard entry point. For a read-like tool (`Read`, `read_file`, `View`, `Grep`, `NotebookRead`) it scans the **actual file contents** via the injected `readFileFn`; for anything else it scans the serialized tool input. Only high-severity rules block:

```js
const HIGH_SEVERITY = new Set(['api_key', 'password', 'token', 'db_conn']);
```

High-severity findings (or any custom rule) return `decision: 'block'` with a human-readable reason; lower-severity matches (email, phone, private IP) are `flagged` but allowed. Either way the event is written to the `interceptions` table so it shows up in Security → Interceptions.

### The PreToolUse hook (`hooks/chronicle-guard.mjs`)

The hook is the thin CLI shim that wires Chronicle's engine into Claude Code's `PreToolUse` event. It reads the hook payload from stdin, POSTs `{tool_name, tool_input}` to `POST /api/security/pretooluse`, and acts on the verdict:

```js
if (verdict.decision === 'block') {
  console.error(verdict.reason);   // stderr is shown to the model
  process.exit(2);                 // exit 2 = block the tool call
}
process.exit(0);                   // allow
```

Two design guarantees make this safe to install:

- **Fails open.** A 3-second `fetch` timeout guards the call; if Chronicle isn't running, or errors, or times out, the hook exits `0` and the tool call proceeds untouched. Security tooling that breaks your editor when it's down is worse than no tooling.
- **Backs up first.** The one-click installer (`POST /api/security/install-hook`) backs up `~/.claude/settings.json` before adding the hook. It is **not installed by default** — you opt in. The endpoint is overridable via `CHRONICLE_URL`.

> **Contributor gotcha — two error heuristics, keep them in sync.** The "is this tool result an error?" check exists in two places: `ERROR_RE` in `server/api.js` (project analytics) and `isErrorResult` in `src/SessionView.jsx` (Overview stats). Change one and the Errors counts diverge. If you touch error detection, touch both.

## Live streaming (`server/live.js`)

Live streaming tails an in-progress session and pushes new messages to the open viewer over SSE. `isLiveCandidate(filePath)` gates it on a **5-minute recency window** (the file was written within the last 5 min); `attachLiveStream(sessionId, res)` opens the SSE stream; `liveStatus()` reports active watchers.

There are two watcher implementations, chosen by source:

| Watcher | Sources | How it detects new content |
| --- | --- | --- |
| `Watcher` (JSONL tail) | Claude Code, Codex | `stat` size polling + incremental read from the last offset; parses new lines only |
| `SqlitePollWatcher` | Cursor, OpenCode | re-parses a temp DB **snapshot** and diffs against the stored message count; WAL-aware mtime |

The JSONL `Watcher` starts at end-of-file (only new content streams), keeps a `partial` buffer for half-written trailing lines, and re-reads from zero if the file is truncated or rotated. The `SqlitePollWatcher` never opens the foreign DB live — the parser layer snapshots it to temp first — and it takes `mtime` from `max(db, db-wal)` because WAL writes may not touch the main file. Both **slow their poll interval** after ~2 minutes of silence and **auto-stop when the last viewer disconnects** (`removeClient` → `close`).

Two implementation facts worth knowing:

- **Watchers live on `globalThis.__chronicleLive`** so a Vite SSR module reload doesn't orphan the poll timers.
- **Live messages use `seq` starting at 1,000,000** to avoid colliding with stored sequence numbers. They exist only in client state until the session is re-imported — live tailing is a view, not a write to the DB.

The UI layer over this (`● LIVE` indicator, exponential-backoff reconnection, "N new messages" button) is covered in [Live streaming](../guide/live-streaming.md).

## Replay engine (`server/replay.js`)

Replay re-executes a session's file and shell operations in an isolated sandbox so you can watch *how* the code was built — deterministically, with **no LLM calls**, and without ever touching the real project.

`REPLAY_ROOT = ~/.chronicle/replay`; each replay gets `~/.chronicle/replay/<id>/`.

**Plan.** `buildPlan(sessionId)` walks the session's messages and extracts the executable steps — `Write`, `Edit`, and `Bash` tool calls — attaching the most recent assistant/thinking text as the step's `reasoning`. It flags steps whose target path escapes the project as `outOfScope`.

**Sandbox seeding.** `startReplay(sessionId, workspace)` wipes and recreates the sandbox, then seeds it from the Git snapshot at session start: it finds the commit at `session.started_at` via the [git engine](git-snapshot-engine.md)'s `commitAt()` and materializes that tree with `git archive | tar -x`. Replay therefore starts from the code as it was *before* the AI touched it — not from current disk.

**Step-by-step.** `previewStep(sessionId, seq)` computes the upcoming diff against current sandbox state (for an `Edit`, it even reports whether the `old_string` still `applies`). `executeStep(sessionId, seq, {confirmCommand})` applies one step:

- **Write / Edit** apply directly to the sandbox path (an absolute project path is remapped into the sandbox; a path that escapes throws).
- **Bash** requires explicit `confirmCommand` — without it, `executeStep` returns `{ needsConfirmation: true }` rather than running anything. Commands run with the sandbox as `cwd` and `HOME` (soft containment), a 60 s timeout, and captured output.

Auto-play (1×/2×/5×) **pauses on errors** and **skips** command steps and out-of-project writes — marking them `skipped` rather than hard-pausing, so the run doesn't look stuck. `openWorkspace()` opens the sandbox in the OS file browser. The real project is never a write target anywhere in this file. See [Replay mode](../guide/replay-mode.md).

## Context causality (`server/causality.js`)

`analyzeCausality(sessionId)` links what the AI **read** to what it **changed**, with a heuristic confidence score — pure structural analysis over the tool-call sequence, no model involved. It collects read-like tool calls (`Read`, `Grep`, `Glob`, …) and change tool calls (`Write`, `Edit`, …), then for each change scores every prior read:

| Confidence | Signal |
| --- | --- |
| **0.95** | read the exact file it then changed |
| 0.55 | read a sibling file in the same directory |
| 0.5 | read a file with the same base name |
| 0.45 | a search pattern that matches the changed file |
| **0.2** | read shortly before the change (background context, within an 8-read window) |

Sources are sorted by confidence and capped per change. The `⛓` badges on Write/Edit messages in the UI open a panel of these source references; the confidence tier is why a same-file read is highlighted while background reads are dimmed. See [Context causality](../guide/context-causality.md).

## Share links (`server/shares.js`)

Sharing serves a session as a tokenized HTML page from the **local app** — nothing is uploaded. The critical property is that **redaction is frozen at creation**:

```js
createShare(sessionId, days = 7)   // → { token, url: `/share/${token}`, expires_at, redactions }
```

`createShare()` runs `scanSession()` over the messages and stores only the **redacted copy** in the `shares.content` column. Because the original is never persisted into the share, a later rule change — or someone reading the DB — cannot leak what was redacted at share time. `listShares()` / `revokeShare(id)` manage the tokens (view counts, immediate revocation), and the public page (`GET /share/:token`) returns `404` once expired or revoked. Default lifetime is 7 days.

## Why it's all heuristic and local

Redaction regexes, live-tail polling, replay's file-op re-execution, and causality's structural scoring are all things a contributor can read, reason about, and audit — no network, no inference, no external dependency. That's the point: **everything heavy is heuristic + local, so Chronicle keeps working with the network unplugged**, and its "intelligence" is inspectable rather than opaque.

## Related
- [Security & sharing](../guide/security-and-sharing.md) — Security Check, custom rules, the hook, share links.
- [Live streaming](../guide/live-streaming.md) — the LIVE indicator and reconnection UX.
- [Replay mode](../guide/replay-mode.md) — the deterministic sandbox replay walkthrough.
- [Context causality](../guide/context-causality.md) — read→change linking and confidence tiers.
- [Git snapshot engine](git-snapshot-engine.md) — how replay seeds its sandbox from history.
