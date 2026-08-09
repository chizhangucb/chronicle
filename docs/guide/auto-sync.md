# Auto-sync

Chronicle keeps itself up to date in the background: new and updated sessions are re-imported automatically, so the app reflects what your AI tools are doing without you ever clicking Sync.

Manual import is still there (the wizard, per-session `⇧⌘U`, per-project sync), but with auto-sync on you shouldn't need it day to day. The tray app watches your tools' log directories and re-imports anything that changed — incrementally, read-only, and entirely on your machine.

## What triggers a sync

Auto-sync is **incremental**: a pass re-imports only sessions whose source file's mtime is newer than the last import. Four triggers cover the ways new data appears:

| Trigger | Why it exists |
| --- | --- |
| **On launch** | Catch everything that happened while Chronicle wasn't running |
| **On system wake** | macOS drops filesystem-watch events across sleep — resuming from sleep is the main way watchers go stale, so wake forces a pass |
| **Every 30 minutes** | A backstop timer, in case a watch event was missed |
| **Filesystem watch** | Known source directories are watched; a change schedules a sync, **debounced ~30 s after the last write** so a streaming session isn't re-imported once per line |

Re-import is `replaceSession` — an idempotent delete-and-reinsert — so syncing an in-progress session is safe: a partial import is simply superseded by the next pass. Your rename (`name`) survives every sync, and source logs are never written to.

## Settings

Two toggles in **Settings**:

- **Auto-sync** — turn the whole mechanism on or off. Off means Chronicle only imports when you ask.
- **Launch at login** — start Chronicle (in the tray) when you log in, so sessions are always fresh when you open the window.

Closing the window hides Chronicle to the tray; auto-sync keeps running there. Quit from the tray menu to stop it entirely.

## The "ongoing" indicator

A session whose source file was written in the last **10 minutes** renders as **ongoing**: an active indicator on the session, with its stats labeled "so far" — counts and durations are a snapshot of a session still being written, and the next sync pass updates them.

Auto-sync is about **durability** (your database catches up on its own); for true real-time message-by-message tailing of an active session, use [Live streaming](./live-streaming.md) — that remains the liveness view.

## Deep links

Chronicle registers the `chronicle://` URL scheme. Opening

```
chronicle://session/<id>
```

focuses (or launches) the app and navigates straight to that session. Any external tool that knows a Chronicle session id — a dashboard, a script, a note — can link directly into the session view.

## Related

- [Importing sessions](./importing-sessions.md) — the manual import wizard and the read-only guarantees auto-sync inherits.
- [Live streaming](./live-streaming.md) — real-time tailing of an in-progress session.
- [Session insights](./session-insights.md) — the stats that auto-sync keeps fresh, including the stored duration metrics.
