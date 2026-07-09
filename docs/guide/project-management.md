# Project management

How Chronicle groups sessions from every AI tool into logical projects, keeps them attached to the right code folder, and lets you sync, rename, associate, and navigate them.

A **project** in Chronicle is a physical code folder, not a tool-specific silo. Sessions from Claude Code, Codex, Cursor, OpenCode, Gemini CLI, and Copilot Chat all aggregate under the same project as long as they ran in the same directory — so one project card shows the full history of a codebase across whatever tools touched it. This page covers how that aggregation works, the per-project controls, and how to move between projects and sessions without losing your place.

## Logical projects and automatic aggregation

Every parser records the physical working directory (`cwd`) each session ran in. On import, Chronicle keys sessions to a project by that path — so if you used Claude Code and Cursor in the same repo, they land on one card automatically, no manual linking. The card surfaces this: a **source pill** per tool that contributed sessions (`✳ claude-code`, `⬡ codex`, `▮ cursor`, `✦ gemini-cli`, …), plus session and message counts and a last-active timestamp.

### Latest cwd wins (repo moves)

Sessions resumed after you move or rename a repo carry the *old* path in their early log records. Chronicle resolves a session to its project using the **last** `cwd` it sees — where the repo and its Git history live now — and collapses subdirectory `cwd`s up to a seen ancestor. To catch this cheaply, the scanner sniffs both the head and tail 64 KB of each log file. The upshot: moving a repo doesn't scatter its history across phantom projects.

## The Git badge

If the project folder is a Git repo, the card shows a pill with the **live branch and commit count** (`⎇ main`, hover for the count). This is genuinely live — Chronicle shells out to `git` on every projects request with no caching, so it always reflects the working tree's current state. If the pill shows a feature branch after you thought you'd merged, the pill is right and the checkout is still on that branch. A project with no Git repo shows *"No Git repo — time travel unavailable"* instead: playback still works, but there's no code snapshot to reconstruct.

## The per-card gear menu

The ⚙ menu on each project card holds four actions:

| Action | What it does |
| --- | --- |
| **⟳ Sync Update** | Re-scans this project's sources and re-imports any new or changed sessions. Idempotent — re-importing a session is a delete-and-reinsert that preserves your Chronicle rename. |
| **ⓘ View Details** | Opens the project analytics home (stat cards, trend chart, source donut, call ranking). |
| **✎ Rename** | Sets a display name for the project. The source folder on disk is *not* touched. |
| **🗑 Remove from Chronicle** | Drops the project from Chronicle's database. Your source logs and project folder are never deleted. |

## Associating sources without a real path

Most tools report a real `cwd`, but Gemini CLI doesn't — its sessions get a virtual path (`gemini-project:<hash>`) and a **"Needs association"** banner. Point it at the actual code folder and click **Associate**; Chronicle relocates the sessions and **merges them into the matching project** if one already exists at that path. Manual association is available for any project this way.

## Unlinking a source

The inverse of aggregation: when a project has sessions from more than one tool, each source shows an **unlink chip** (`⛓✕ cursor`) in the project header. Unlinking splits that source's sessions out into their own separate project — useful when two tools happened to share a directory but you want to track them apart.

## Navigating: breadcrumb switchers

Inside a project or session view, the breadcrumb at the top is made of two dropdowns — a **project picker** and a **session picker**. They let you jump to another project or another session *in place*, without backing out to the projects grid. The session view is keyed by session id, so switching remounts cleanly and the breadcrumb, picker, and title all update together.

## Syncing a single session

From within a session you can re-import just that one session with **⇧⌘U** (Sync Update this session) — handy when a session is still being written and you want the latest turns pulled into the database. This re-imports only the current session, not the whole project.

## Session cards and real context usage

Each session card shows its display name — resolved by a single precedence rule: your Chronicle rename → the parsed title → the first prompt (see `sessionDisplayName()` in `src/ProjectDetail.jsx`) — its source pill, and a context indicator:

- **`⧉ 42k ctx`** — the real context-window size at the session's last message, read from the tool's own usage records.
- **`⧉ ~38k tokens`** — a fallback estimate (~4 characters per token) shown when real usage isn't available. Real context populates only on import, so **Sync Update or re-import** after upgrading to backfill it.

The time-range selector (Today / All time / 7 / 30 / 365 days) rescopes the project's stats and charts.

## Related

- [Importing sessions](./importing-sessions.md) — the import wizard, the six supported tools, and the read-only guarantees behind aggregation.
- [Session insights](./session-insights.md) — what each session card's stats mean once you open it: Active Duration, cost, and the context-window bar.
