# Keyboard Shortcuts

Every keyboard shortcut in Chronicle, grouped by where it applies.

Chronicle is keyboard-first: you can open a session, move through the timeline, and distill a transcript without touching the mouse. Shortcuts are registered per context, so the same key can mean different things in Playback versus Refine. Below, `⌘` is the macOS Command key — on Windows and Linux (source builds) it maps to `Ctrl` everywhere, since every handler listens for `metaKey || ctrlKey`.

## Global

Available from anywhere in the app.

| Shortcut | Action |
| --- | --- |
| `⌘K` | Open the command palette (global search across sessions) |

## Session view

Active whenever a session is open. These switch modes and drive the search filter.

| Shortcut | Action |
| --- | --- |
| `⌘F` | Focus the in-session search box |
| `⌘1` | Overview mode |
| `⌘2` | Playback mode |
| `⌘3` | Refine mode |
| `⌘4` | Replay mode |
| `⇧⌘U` | Sync (re-import) this session |
| `Esc` | Clear the search filter and unfocus the search box |

## Playback

Available while the code panel is showing a snapshot in Playback mode.

| Shortcut | Action |
| --- | --- |
| `D` | Toggle diff view for the selected file (ignored while typing in a field) |

The `D` toggle is suppressed when focus is in an `input` or `textarea`, so typing a filename filter never flips the view.

## Timeline

Active when the timeline slider is focused (click it first). The timeline seeks the whole session to a point in time.

| Shortcut | Action |
| --- | --- |
| `←` / `→` | Nudge the playhead by 1% |
| `Home` | Jump to the start of the session |
| `End` | Jump to the end of the session |
| Click / drag | Seek to the pointer position |

## Refine

Active in Refine mode, where you distill a transcript down to a shareable core by keeping, deleting, editing, and inserting messages.

| Shortcut | Action |
| --- | --- |
| `K` | Keep the selected message and advance to the next |
| `D` | Delete (strike) the selected message and advance to the next |
| `E` | Edit the selected message inline |
| `I` | Insert a note after the selected message |
| `↓` / `j` | Move the selection down |
| `↑` | Move the selection up (`⇧K` also moves up) |
| `⌘Z` | Undo |
| `⇧⌘Z` | Redo |
| `⌘S` | Export the refined transcript |
| `Esc` | Cancel the current inline edit |

> **Note:** `K` on its own keeps a message, so it is not the vim "up" key here — use `↑` (or `⇧K`) to move up and `j` / `↓` to move down.

## Command palette

Active while the `⌘K` palette is open.

| Shortcut | Action |
| --- | --- |
| `↑` / `↓` | Move through results |
| `Enter` | Open the highlighted result |
| `Esc` | Close the palette |

## Related

- [Time Travel](../guide/time-travel.md) — Playback mode, snapshots, diff, and the timeline these shortcuts drive.
- [Refine Mode](../guide/refine-mode.md) — the Keep / Delete / Edit / Insert workflow the Refine shortcuts belong to.
