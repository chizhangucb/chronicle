# Time travel

Chronicle's signature feature: click any message in a session and see your code exactly as it was at that moment, reconstructed from Git history.

Playback mode is where the "time machine" name earns itself. Instead of scrolling a flat transcript, you move through the session and watch the codebase change underneath it. There's no separate snapshot store and no reliance on your current working tree — Chronicle matches each message's timestamp to your Git history and rebuilds the tree and file contents from there. **Git is the source of truth for code state.**

## The Playback layout

Open a session and switch to **Playback** (left rail, or `⌘2`). It's a three-pane view:

- **Conversation list (left).** Every message, typed by role — User, Assistant, Thinking, Tool Call, Tool Result — using the same role-accurate labels as the rest of the app. Click a message to select it. Long messages truncate with a "Show all" toggle; on very large sessions Chronicle renders a window of ~400 rows around your selection (with "earlier / later messages" buttons) so scrolling stays fast.
- **Code snapshot (middle).** The file tree and file contents at the selected message's moment in time.
- **TimberLine (bottom).** A timeline of the whole session for scrubbing.

Selecting a message drives both other panes at once.

## How a snapshot is resolved

When you click a message, Chronicle takes its timestamp and asks Git for the **nearest commit at or before** that time (`commitAt()` in `server/git.js`, which runs `git rev-list -1 --before`). That commit becomes the snapshot:

- The **file tree** is `git ls-tree` at that commit.
- Selecting a file shows its contents via `git show <commit>:<file>`.
- Files that were **changed in that commit** get a green dot in the tree and the first one is auto-selected, so you land on what the AI was actually touching.

If a message predates all history, Chronicle falls back to the oldest commit and flags it with a **"before first commit"** badge, so you know you're looking at the earliest available state rather than a precise match.

> **Note:** A snapshot is reconstructed history, not your current disk. What you see is how the file looked at that commit — not what's in your working tree right now, and not an uncommitted intermediate state.

## Diff view

Press **`D`** (or the **± Diff** button in the code toolbar) to toggle the diff. It compares the selected file against its **previous committed version** and renders added/removed lines inline. Long runs of unchanged lines are compressed to a few lines of context (with a "··· N unchanged lines ···" marker) so real changes stand out. If the file didn't actually change at this snapshot, Chronicle tells you so rather than showing an empty diff.

## The TimberLine

The TimberLine is the scrubber that ties conversation time to code time. Its marks:

- **Blue dots** — user messages
- **Green squares** — Git commits
- **Gray ticks** — AI and tool events

Interacting with it:

- **Click or drag** anywhere to seek. Chronicle snaps to the nearest message and updates the snapshot to match.
- **Hover** to see the timestamp under the cursor.
- When the timeline is focused: **`←` / `→`** nudge the cursor by 1%, and **`Home` / `End`** jump to the start or end of the session.

On huge sessions the timeline decimates AI/tool ticks (down to ~600) so it stays legible — but **commits always render**, because they're the anchors that make time travel work.

## Git prerequisites and fidelity

Time travel needs a Git repository with commits. If the project isn't a repo (or has none), the code pane shows a "No Git history" empty state and explains that conversation playback still works — you just don't get snapshots. The project's Git pill and header tell you the repo state at a glance (see [Project management](./project-management.md)).

Fidelity scales with commit frequency: Chronicle can only reconstruct code at points your history actually recorded, so a project that commits often gives you a tighter, more accurate replay than one with a handful of large commits. For how the snapshot engine works end to end — commit matching, tree/file resolution, merge-commit handling — see [Git snapshot engine](../architecture/git-snapshot-engine.md).

## Related

- [Quickstart](./quickstart.md) — the fastest path to your first snapshot.
- [Search & filtering](./search-and-filtering.md) — narrow a long session down to the messages that matter before you scrub.
- [Git snapshot engine](../architecture/git-snapshot-engine.md) — how Chronicle reconstructs code from `rev-list` / `ls-tree` / `show`.
