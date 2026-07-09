# Security and sharing

Chronicle scans your sessions for secrets, can block a coding agent from ever reading them in the first place, and lets you share a session as a redacted, self-hosted link — all locally, with your original logs never modified.

AI coding sessions are full of things you don't want to leak: API keys pasted into a prompt, a `.env` a tool read, a database URL in a stack trace. Chronicle handles this in three layers — **detection** (scan a session and preview what's sensitive), **prevention** (a pre-tool-use guard that stops secrets reaching the model at all), and **safe sharing** (a redacted, expiring link served from your own machine). All three run on local heuristics with no LLM calls, and redaction is one-way: the copies Chronicle produces are redacted, and your source logs are never touched.

> **Local-first:** redaction is baked in at the moment a share is created or an export is written. Editing a rule later, or someone reading Chronicle's database, cannot un-redact an already-shared copy — the original never left your machine to begin with.

## Security Check

From a session, open **🛡 Security Check** to scan it for sensitive content. Chronicle checks every message's text and tool input against its built-in rules (`server/security.js`) and shows a side-by-side preview: **Detected** (the original with each finding highlighted) next to **Redacted output** (what a shared or exported copy would contain).

The built-in rules (`BUILTIN_RULES`) need no configuration and cover:

| Rule | Catches |
| --- | --- |
| API keys | `sk-…`, `anthropic-…`, AWS `AKIA…`, GitHub `ghp_`/`gho_`, Slack `xox…`, Google `AIza…` |
| Passwords | `password`/`passwd`/`pwd`/`secret` = value assignments |
| Bearer / JWT tokens | `Bearer …` headers and `eyJ…` JWTs |
| DB connection strings | `postgres://`, `mysql://`, `mongodb+srv://`, `redis://`, `amqp://`, `mssql://` |
| Emails | `name@host.tld` |
| Phone numbers | international and dashed formats |
| Private IP addresses | `10.x`, `127.x`, `192.168.x`, `172.16–31.x` |

On seeded test secrets these rules hit **13 of 13**. A scan summarizes the total finding count and a per-rule tally, so you can see at a glance what a session contains before you do anything with it.

### Custom rules

Built-ins won't know your organization's key prefixes, so the **Rules** panel lets you add your own using simple globs — `*` matches any run of non-whitespace characters, `?` matches a single character:

- A **redact** rule like `KITE-*` masks anything matching that shape.
- An **allow** rule like `*@company.com` *protects* matches from redaction — useful when a broad built-in (e.g. the email rule) would otherwise scrub something you want to keep.

Priority is deterministic (`scanText()`): **custom rules run before built-ins**, allow rules protect their spans, and on any overlap the **earlier match wins**. In practice that means specific, custom, and allow rules take precedence over broad built-in redaction. Rules can be enabled, disabled, or deleted, and they apply to every scan, export, and share.

### Redacted export

**Export redacted copy** downloads a one-way redacted Markdown transcript (`GET /api/sessions/:id/export-redacted`). It's the safe artifact to attach to a bug report or paste into a doc. The session's stored messages are read-only throughout — the export is a fresh redacted rendering, not an edit.

## Real-time protection

Detection after the fact is useful, but the stronger guarantee is stopping a secret from reaching the model *before* a tool runs. Chronicle ships a Claude Code **PreToolUse hook**, `hooks/chronicle-guard.mjs`, that does exactly this.

Install it from **Security → Real-time protection setup**. Chronicle backs up `~/.claude/settings.json` to `~/.chronicle/backups/hooks/` first, then registers the guard for the `Read | Grep | Bash | WebFetch` tools. From then on, before Claude Code runs one of those tools, the guard asks Chronicle to scan the tool content (`preToolUseCheck()`):

- For **Read-like tools** (`Read`, `Grep`, `read_file`, `View`, `NotebookRead`) that carry a file path, Chronicle scans the **actual file contents** — so a secret in a file the agent is about to open is caught, not just secrets typed into the prompt.
- For other tools, it scans the tool input itself (the Bash command, the WebFetch URL, and so on).

**High-risk findings** — API keys, passwords, tokens, DB connection strings, and any custom rule — **block the call** (the hook exits `2`, and its explanation is shown to the model so it knows why and can adjust). Lower-risk matches are **flagged** but allowed. Either way the event is written to **Security → Interception records**, giving you a running log of what was blocked or flagged, on which tool and file, to help you tune your rules.

> **Fails open, and off by default.** The guard talks to Chronicle over `http://localhost:4173` with a 3-second timeout. If Chronicle isn't running, it exits cleanly and the tool call proceeds — it will **never** break your coding session. It is **not installed by default**; you opt in from the Security page. Other agents that support command hooks can point at `node hooks/chronicle-guard.mjs` (it reads the tool payload on stdin; exit `2` blocks).

## Share links

To share a session — with a teammate, in an issue — open **🛡 Security Check → Create share link**. Chronicle mints a tokenized URL served by the *local* app:

```
http://localhost:4173/share/<token>
```

What makes this safe is *what* it stores. `createShare()` runs the session through redaction and saves **only the redacted copy, frozen at creation time**, along with a random token and an expiry (default **7 days**). The original messages never leave your machine, and because the redacted snapshot is frozen, later rule changes can't retroactively expose anything. The share page is a self-contained dark HTML view marked `noindex`, with a banner noting the content was redacted at share time and when it expires. The link URL is copied to your clipboard, and the button reports how many redactions were applied.

### Share management

**Security → Share management** lists every link you've created — active or expired — with its title, creation and expiry dates, and view count. **Revoke** deletes a link immediately; visiting a revoked or expired token returns a plain "expired or been revoked" page. Since the whole thing is served by your own Chronicle instance, a share is only reachable while your app is running and only for as long as you allow.

## The three layers together

- **Detect** — scan any session, preview detected-vs-redacted, tune with custom glob rules.
- **Prevent** — opt into the pre-tool-use guard to block secrets before an agent reads them; review the interception log.
- **Share** — publish a redacted, expiring, self-hosted link; revoke it any time.

For the redaction rule engine, the interception data model, and how the share page is rendered, see the architecture notes below.

## Related

- [Session insights](./session-insights.md) — the Overview stats, cost, and usage view that a Security Check complements.
- [Security, live & replay internals](../architecture/security-live-replay.md) — the redaction engine, interception storage, and share-page rendering.
- [Privacy and data](../reference/privacy-and-data.md) — Chronicle's local-first guarantees and the full list of outbound network calls.
