# Search & filtering

Two complementary ways to find things: type filters and keyword search *within* a session, and a global command palette that searches *across* every session you've imported.

Sessions get long — thousands of messages is normal. Chronicle gives you a fast way to narrow one session down to the messages you care about, and a separate, app-wide palette for the "where did I do that thing?" question when you don't even know which session it was. Neither one touches your data: filtering and searching are read-only and leave the timeline and snapshots untouched.

## Filtering within a session

In **Playback** mode, a row of filter chips sits in the toolbar:

- **Conversation** — user and assistant messages
- **Tool** — tool calls and their results
- **Thinking** — the model's thinking blocks

Chips combine with **OR** logic: enable Conversation *and* Tool to see both. The **Tool** chip pairs requests with results, so you keep a call and its output together rather than orphaning one. Enabling no chips shows everything. A **Clear filter** button appears once any chip or search term is active.

Filtering is **non-destructive** — it changes only which rows are listed. The TimberLine and code snapshots still reflect the full session, so you can filter the conversation without losing your place in time. (To actually distill a session down and export it, that's [Refine mode](./refine-mode.md), a different tool.)

### Keyword search (`⌘F`)

Press **`⌘F`** to focus the in-session search box. It filters the message list live against message text, tool names, and tool input, with a **300 ms debounce** so typing stays smooth. Matches are highlighted inline, and a counter in the toolbar shows `Match: <visible>/<total>`. Search combines with the type chips — filter to Tool calls, then search for a filename, and you get only the tool calls that mention it. `Esc` clears the search.

## Global search (`⌘K`)

The command palette is the cross-session view. Open it with **`⌘K` from anywhere**, or the **🔍** button on the home page. Type a query and Chronicle searches across *all* imported session content, grouped per session with a highlighted snippet and a match count.

The palette gives you:

- **Scopes** — **All**, **Code**, or **Chat**, to restrict matches to code-ish content, conversation, or both.
- **Time filter** — All Time, 7 Days, 30 Days, or 1 Year.
- **Project filter** — narrow to a single project.
- **Recent Access** — with an empty query, the palette lists your recent sessions, so it doubles as a quick jump-back.
- **Keyboard navigation** — **`↑` / `↓`** to move, **`Enter`** to open the highlighted result (jumping straight into that session), **`Esc`** to close.

> **Note:** Global search is `LIKE`-based, not a full-text index. It scans message text and tool input directly, which is plenty fast at Chronicle's scale (tens of thousands of rows). If your database ever grows to where this feels slow, that's the signal to revisit — until then, the simpler approach keeps imports cheap and behavior predictable.

## Related

- [Time travel](./time-travel.md) — once you've found the right messages, scrub through the code they produced.
- [Keyboard shortcuts](../reference/keyboard-shortcuts.md) — every shortcut, including search and navigation, by mode.
