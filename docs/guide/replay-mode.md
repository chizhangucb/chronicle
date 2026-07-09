# Replay Mode

Re-execute a session's file writes, edits, and shell commands step by step in a throwaway sandbox — deterministically, with no AI in the loop and your real project never touched.

Replay Mode (**⌘4**) answers "what did this session actually *do* to the code?" by replaying the concrete operations the AI ran — `Write`, `Edit`, and `Bash` steps — into an isolated workspace seeded from your Git history. There are **no LLM calls**: Chronicle already has every operation recorded in the transcript, so replay just applies them in order. That makes it deterministic and safe — you can watch a change materialize, inspect each diff before it lands, and open the finished sandbox in your editor, all without writing a single byte to your project.

## The sandbox

Each replay runs in its own directory under `~/.chronicle/replay/<id>/`. When you start a replay, Chronicle:

1. Wipes and recreates that sandbox directory.
2. Finds the Git commit at-or-before the session's start time and **materializes that tree into the sandbox** (via `git archive <commit> | tar -x`). This is the code as it looked when the session began.
3. Replays the session's operations on top of that seed.

The seed commit is shown as a `⎇ seeded @ <hash>` pill. If the project isn't a Git repo (or the session predates all history), the sandbox simply starts empty. Either way, **your real project directory is never modified** — replay only ever writes inside `~/.chronicle/replay/<id>/`.

> **Local-first:** Replay reconstructs state from your Git history and the recorded operations, not from a live copy of your working tree. Git is the source of truth; the sandbox is disposable.

## Stepping through

The left pane lists the extracted steps (📄 write, ✏️ edit, ＄ command) in order. Selecting a step shows, on the right:

- **AI reasoning before this step** — the assistant/thinking text that immediately preceded the operation, so you know *why* it happened.
- **An upcoming-diff preview** — the change computed against the sandbox's *current* state. Writes and edits render as a line diff (new file, added, removed lines); commands render as the `$ command` that would run.

Each step gives you three moves:

- **Execute This Step** — apply the write or edit to the sandbox.
- **Skip** — advance without applying (useful when a step targets something outside the project).
- **Look Back** — step to the previous operation to re-inspect it.

Because edits are applied as exact `old_string → new_string` replacements, an edit whose `old_string` no longer matches the sandbox file (for example, because you skipped an earlier step it depended on) is flagged rather than silently misapplied — you can Skip it or execute the missing prerequisites and Retry.

## Shell commands always ask first

Write and edit steps apply on click. **Shell commands never do** — every `Bash` step requires an explicit, per-step confirmation (the button is styled as a warning, `⚠ Execute command`). Confirmed commands run with the **sandbox as their working directory** and a soft-contained `HOME` pointing at the sandbox, with a time limit and captured output. This keeps a stray `rm` or build command scoped to the disposable workspace instead of your machine.

## Auto-play

Auto-play walks the steps for you at **1x / 2x / 5x**. It is deliberately conservative:

- It **pauses on the first error** so you can inspect and Retry, rather than plowing ahead on a broken state.
- It **skips** shell commands (they always need manual confirmation) and any write whose target is **outside the project**, marking them `skipped` — it never hard-pauses on them. Auto-play that stalled on a command used to look broken; skipping instead keeps it moving.

A progress bar tracks executed vs. total steps. When the run completes you get a **Replay complete** state and an **Open in Finder** action that reveals the finished sandbox so you can diff it against your real project or open it in an editor.

If a session contains no `Write`/`Edit`/`Bash` operations, Replay shows a "Nothing to replay" state — there's nothing to reconstruct.

## Related

- [Time travel](./time-travel.md) — Playback mode and the Git snapshot engine that also powers replay's seed commit.
- [Security, live & replay internals](../architecture/security-live-replay.md) — how `server/replay.js` builds the plan, sandboxes execution, and contains shell commands.
