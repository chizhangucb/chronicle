# Live streaming

Open a session that's still being written and Chronicle tails it in real time — new messages appear as the AI produces them, with a live indicator and automatic reconnection.

If a session's log file was written in the last five minutes, Chronicle treats it as **live** and attaches a stream: as your AI tool appends turns to its log, they show up in Playback within a second or two, no refresh needed. This works because Chronicle reads logs incrementally from disk — no coordination with the tool itself — so it can follow along with an active Claude Code or Cursor session while it's still running. Like everything else, it's local: reads only, originals untouched.

## When a session goes live

The trigger is simple and file-based: a session is a **live candidate** if its log file's modification time is within the last **5 minutes** (`isLiveCandidate()` in `server/live.js`). Open such a session and the client automatically connects to `GET /api/sessions/:id/live`, a **Server-Sent Events** stream. There's no button to press — recency does it.

## What you see

- **New messages fade in** as they arrive, visually distinct from the already-loaded history.
- **Auto-scroll when you're at the bottom** — if you're following the tail, the pane stays pinned to the newest message.
- **A "N new messages" button** when you've scrolled up to read something. Chronicle won't yank you away from what you're reading; instead a floating `↓ N new messages` button appears, and clicking it (or scrolling back to the bottom) jumps you to the latest and clears the count.

### The live indicator

A status pill reflects the connection, surfaced app-wide while the session is open:

- **● LIVE** — connected and tailing.
- **Reconnecting** — the stream dropped and Chronicle is retrying.
- **Stopped** — the stream ended (the file went quiet long enough, or retries were exhausted).

On a dropped connection the client retries with **exponential backoff** (a few attempts, each waiting longer), resetting the moment fresh messages arrive; after the last attempt it settles into **Stopped**. When you close the session, the watcher stops on both ends — the client disconnects and the server tears down the file watcher once its last viewer leaves, so nothing keeps polling in the background.

While a session is live, its source-log deletion is disabled — you can't delete a file that's actively being written.

## How it tails (two strategies)

Different tools store logs differently, so Chronicle uses two watchers, both read-only:

- **JSONL tail** (Claude Code, Codex) — the `Watcher` remembers the byte offset at end-of-file and, on a cheap ~700 ms `stat` poll, reads only the *new* bytes when the file grows, parsing each appended line into messages. It handles a truncated or rotated file by re-reading from the start, and skips any line it can't parse rather than breaking the stream.
- **SQLite poll** (Cursor, OpenCode) — these tools write to a SQLite database, so the `SqlitePollWatcher` does a **read-only periodic re-parse**: it watches the database file's modification time (WAL-aware — it also checks the `-wal` sidecar, since writes may land there and not touch the main file) and, when it changes, re-parses and emits only the messages beyond what it last saw. The parser snapshots the database to a temp copy before reading, so the tool's live database is never opened directly or written to.

Both watchers **slow their polling after about two minutes of silence** to stay cheap on an idle session, and speed back up the instant new content appears.

> **Note:** Live messages are streamed straight into the view and given high sequence numbers (starting at 1,000,000) so they never collide with stored ones. They live in the client only until the session is re-imported — do a Sync Update (⇧⌘U) to persist the newly-streamed turns into the database.

## Related

- [Importing sessions](./importing-sessions.md) — how sessions get into Chronicle in the first place, and the read-only guarantees the live tail also honors.
- [Security, live & replay internals](../architecture/security-live-replay.md) — the `Watcher` / `SqlitePollWatcher` internals, SSE wiring, and watcher lifecycle in `server/live.js`.
