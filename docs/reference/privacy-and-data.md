# Privacy & Data

What Chronicle stores, where it stores it, and the complete list of the few things that ever leave your machine.

Chronicle is local-first by design, not by configuration. Parsing, storage, viewing, replay, and even share-link generation all happen on-device, and there is no cloud backend to opt out of. This page is the honest accounting: the guarantees, the exact outbound network calls (there are only three, all user-initiated or optional), and where your data physically lives.

## The local-first guarantee

- **All work happens on-device.** Importing, parsing, storing, searching, time-travel, causality analysis, redaction, replay, and building share pages run entirely on your machine.
- **No LLM calls, anywhere.** Everything that could look like AI — causality confidence tiers, secret redaction, cost computation — is a local heuristic or a static table. Chronicle never sends your conversations to a model.
- **No cloud backend, no account.** There is nothing to sign into and no server that holds your data.
- **Your source logs are never written to.** Chronicle reads your tools' logs; it does not modify or delete them. SQLite-backed sources (Cursor, OpenCode) are copied to a temp location — including their `-wal`/`-shm` sidecars — and Chronicle opens the *copy*, never your live database.
- **Your project repositories are never written to.** The Git snapshot engine is strictly read-only: it shells out to `git rev-list`, `ls-tree`, and `show` to reconstruct past code state from history. It never commits, checks out, or stages anything.
- **Read-only on foreign systems.** The same read-only posture applies to every tool's data — Chronicle only ever observes.

## What leaves the machine

By default Chronicle makes **no** network calls to view or manage your sessions. Only three outbound calls exist, and each is either optional or explicitly triggered by you:

1. **Update check and download.** In the packaged desktop app, `electron-updater` polls the GitHub release feed for the public `chizhangucb/homebrew-chronicle` tap and downloads new notarized builds in the background. This is the standard app-update path; it carries no session data.
2. **Feedback (only when you submit it).** Submitting the feedback form POSTs to the hosted relay at `relay.getchronicle.dev`. The message is **always appended to `~/.chronicle/feedback.log` locally first**, so nothing depends on the network; if the relay is unreachable the UI falls back to a `mailto:` draft. The sender email field is optional — provide it and it becomes the reply-to address; leave it blank and nothing identifies you.
3. **Skills GitHub import (only when you ask).** Importing a skill from GitHub does a shallow clone of the **public repository you choose**. Nothing is uploaded; it is a one-way fetch you initiate.

Nothing else leaves the machine. In particular:

- **Skill ratings and tags are local-only.** `updateSkillMeta()` writes them to your local store and never uploads them.
- **Session content is never transmitted** for parsing, viewing, or analysis.

## Share links stay local

A share link is served by **your own running Chronicle**, not a hosted service. When you create one, Chronicle stores a **redacted copy of the transcript, frozen at creation time**, and serves it from the local `/share/:token` page. The original session is never uploaded, and edits after creation don't change an existing share. You can see view counts and revoke a link immediately from Share Management.

## Where your data lives

Everything Chronicle persists is under `~/.chronicle/` (see [Configuration](./configuration.md) for the full layout): the SQLite database at `~/.chronicle/chronicle.db`, the central skills store, replay sandboxes, and `feedback.log`. It stays on your disk.

> **Redaction is one-way.** When Chronicle redacts secrets — for a share link, an exported Markdown transcript, or the security scan — it replaces the sensitive text; it does not keep a reversible mapping. The redacted artifact cannot be turned back into the original, and your stored originals are never modified in the process.

## Related

- [Security & sharing](../guide/security-and-sharing.md) — the Security Check, custom redaction rules, the pre-tool-use hook, and share management.
- [Configuration](./configuration.md) — the `~/.chronicle/` layout and the environment variables behind these defaults.
