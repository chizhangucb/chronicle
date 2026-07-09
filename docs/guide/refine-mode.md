# Refine Mode

Distill a long AI coding session down to the parts worth keeping — clean documentation or a reusable prompt — by curating messages in a split-pane editor and exporting the result.

Refine Mode (**⌘3**) treats a session transcript as raw material. You keep the messages that carry signal, drop the noise, edit what needs tightening, and insert your own connective notes, then export Markdown or a bare prompt. Everything happens in your browser against the already-imported messages; the original session log is never touched, and nothing is uploaded. The left pane is the full transcript with per-message controls; the right pane is a live **Compressed Preview** of what will actually export.

## The split pane

- **Left — the transcript.** Every message as a row, tagged with its role and a per-message token badge. This is where you curate.
- **Right — Compressed Preview.** Exactly what your export will contain, updated as you edit. Three view chips control what it shows:
  - **👁 Full** — every message, with deleted ones struck through so you can see what you cut in context.
  - **≶ Changes Only** — just the messages you've deleted, edited, or inserted, for reviewing your edits.
  - **⌦ Hide Deleted** — only the kept messages, i.e. the clean export as it will land.

Message labels are role-accurate and come from the single canonical map in `src/kinds.js` — the same vocabulary Playback uses (User, Assistant, Thinking, Tool Call, Tool Result, Inserted). Refine renders them as uppercase tags, but the words never drift from the rest of the app.

> **Token badges are export size, not context window.** The per-message and total token counts estimate the size of the *export document* (roughly characters ÷ 4), with tool calls truncated to one-line previews. This is not the model's context-window usage — for that, see [Session insights](./session-insights.md).

## Operations

Each row has four operations, available as buttons or single-key shortcuts when the row is selected:

| Key | Op | Effect |
| --- | --- | --- |
| **K** | Keep | Un-deletes the message (marks it to include). |
| **D** | Delete | Excludes the message from the export (struck through, not removed). |
| **E** | Edit | Opens an inline textarea in the preview pane; commits on blur, **Esc** cancels. You can also double-click any preview block to edit it. |
| **I** | Insert | Adds an empty **Inserted** note *after* the selected row, ready to type your own connective prose. |

Use **↑/↓** (or **j/k**) to move the selection. Pressing **K** or **D** advances to the next row, so you can triage top-to-bottom with one hand.

### Noise starts pre-deleted

Tool results and thinking blocks are the bulk of a transcript's volume and rarely belong in a distilled artifact, so **they start deleted**. If a particular tool result or thought is worth keeping, select it and press **K**. Everything else — user turns, assistant turns, tool calls — starts kept.

### Bulk controls

- **Keep All / Delete All / Insert at start** buttons sit above the transcript.
- **By type** toggle chips appear when the session has more than one message kind. Each chip shows a kind and its count (e.g. `Tool Result 214`); clicking it flips that entire kind in or out at once — the fast way to, say, drop every tool call or bring back all assistant turns.

## The status bar

The bottom bar tracks your edit session and drives the export:

- **Undo / Redo / Reset** — **⌘Z** undoes, **⇧⌘Z** redoes, and the reset control (⟲) reverts to the original transcript. Typing inside an edit is a single undo step, not one per keystroke.
- **Token stats** — `Original → Compressed → Saved`, plus a bar showing the percentage of tokens you've trimmed. It fills as you delete.
- **Change counts** — deleted / edited / inserted (− / ✎ / ＋).

## Export

The **Export** menu (or **⌘S** for the Markdown default) writes a file straight to your machine:

- **📄 Export Markdown** — a titled document with a source/date/kept-count header, then each kept message under a `### Role` heading. Good for docs, PRs, or a session write-up.
- **⌁ Export as Prompt** — just the kept message text, joined with blank lines and no headers or labels. Good for seeding a fresh AI session or a reusable prompt template.

Both export only the *kept* messages in transcript order, so what you see in **⌦ Hide Deleted** is exactly what you get.

## Related

- [Session insights](./session-insights.md) — the Overview stats, real context-window usage, and cost breakdown that the token badges here deliberately do *not* try to reproduce.
- [Keyboard shortcuts](../reference/keyboard-shortcuts.md) — every Refine key (K/D/E/I, ⌘Z, ⇧⌘Z, ⌘S) and the shortcuts for the other session modes.
