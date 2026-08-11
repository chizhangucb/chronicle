# Privacy & Data

What Chronicle stores, where it stores it, and the exact outbound network calls it makes.

Chronicle is local-first by design, not by configuration. Parsing, storage, viewing,
time-travel, causality analysis, and redaction all happen on-device, and there is no cloud
backend to opt out of. This page is the honest accounting: the guarantees, what actually
leaves your machine, and where your data physically lives.

## The local-first guarantee

- **All work happens on-device.** Importing, parsing, storing, searching, time-travel,
  causality analysis, redaction, and computing Insights run entirely on your machine.
- **No LLM calls, anywhere.** Everything that could look like AI — causality confidence tiers,
  secret redaction, cost computation, Insights aggregation — is a local heuristic or a static
  table. Chronicle never sends your conversations to a model.
- **No cloud backend, no account.** There is nothing to sign into and no server that holds
  your data.
- **Your source logs are never written to.** Chronicle reads your tools' logs; it does not
  modify or delete them. SQLite-backed sources (Cursor, OpenCode) are copied to a temp
  location — including their `-wal`/`-shm` sidecars — and Chronicle opens the *copy*, never
  your live database.
- **Your project repositories are never written to.** The Git snapshot engine is strictly
  read-only: it shells out to `git rev-list`, `ls-tree`, and `show` to reconstruct past code
  state from history. It never commits, checks out, or stages anything.
- **Read-only on foreign systems.** The same read-only posture applies to every tool's data —
  Chronicle only ever observes.

## What leaves the machine

**Nothing, automatically.** Chronicle's server makes **zero outbound network requests** —
there's no telemetry, no analytics, no update check, and no hosted service it talks to. This
was verified directly against the source: the server code contains no `fetch`, no HTTP client,
and no hardcoded external URL. The client makes exactly one network call, `fetch('/api/...')`,
and it's local — to Chronicle's own server on your machine.

The single external URL anywhere in the app is a plain link in the sidebar (not a network call
Chronicle makes on your behalf), which opens `github.com/chizhangucb/chronicle/issues` in your
browser if you click it. That's the browser navigating, not Chronicle phoning home.

Because `npx chronicle-cli` fetches the package itself from the npm registry, that one-time
(or per-version) download is the only network activity involved in running Chronicle at
all — and it carries no session data, just the package files, exactly like installing any
other npm package.

## Where your data lives

Everything Chronicle persists is under `~/.chronicle/` (see
[Supported tools & configuration](./supported-tools.md) for the full layout): the SQLite
database at `~/.chronicle/chronicle.db`, `config.json` for local settings, and pre-deletion
backups under `backups/`. It stays on your disk. Override the location with
`CHRONICLE_DATA_DIR`.

## Security scan & redaction

Chronicle's built-in **Security Check** scans a session's messages for likely secrets (API
keys, passwords, tokens, connection strings, emails, phone numbers, private IPs) using local
regex detectors, plus any custom glob rules you add. You can export a **one-way redacted**
copy of a session as Markdown from the same panel.

> **Redaction is one-way.** When Chronicle redacts secrets — for an exported Markdown
> transcript or the security scan preview — it replaces the sensitive text; it does not keep a
> reversible mapping. The redacted artifact cannot be turned back into the original, and your
> stored originals are never modified in the process.

## Deleting data

- **Delete a session** from its menu — this removes it from Chronicle's database (with a
  backup written first) and records a tombstone so a later sync of the same source log won't
  re-import it. "Undo" simply forgets the tombstone; your original log file is never touched
  either way.
- **Delete a project** — same tombstone treatment, applied to every session that belonged to
  it.
- **Wipe everything** — stop Chronicle and delete `~/.chronicle/` (or your `CHRONICLE_DATA_DIR`
  override). This removes the local database Chronicle built; it never touches your AI tools'
  original logs, so nothing about your actual coding history is lost.

## Related

- [Supported tools & configuration](./supported-tools.md) — the `~/.chronicle/` layout and the
  environment variables behind these defaults.
- [How it works](../architecture/how-it-works.md) — the security engine implementation.
