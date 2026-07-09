# Importing sessions

The four-step import wizard pulls conversation logs from six AI coding tools into Chronicle's local database — read-only, session by session, idempotent on re-run.

Importing is where Chronicle meets your existing tools. It never asks you to change your workflow: it reads the logs your AI assistants already write to their standard locations, normalizes them into one event model, and stores them in a local SQLite database at `~/.chronicle/chronicle.db`. Your original logs are never modified — a guarantee that holds even for the SQLite-backed tools.

## The import wizard

Open it with **+ Import Sessions** on the home screen. The wizard is a four-step flow, shown as a stepper at the top:

**1. Select Source.** Chronicle scans each tool's standard log directory and shows only the sources it actually found, with a session count per source. If nothing turns up, you'll see "No local AI tool logs found."

**2. Select Files.** This is the workhorse step. Projects are listed with their physical path; where Chronicle can enumerate individual sessions, each project expands into a checklist of sessions. Every project (and session) carries a badge:

- **NEW** — never imported.
- **Partial N/M** — some of the project's sessions are already imported.
- **Imported** — fully imported already.

New sessions are **auto-selected** the moment you pick a source, so the common case (import everything new) is one click away. You also get:

- a **search** box that filters projects *and* sessions by name, path, or id;
- **Rescan** to re-scan the source without leaving the wizard (it keeps your current selections and auto-selects any newly appeared NEW sessions);
- **Select Directory Manually** to point Chronicle at an arbitrary absolute log directory — useful for logs in a non-standard place;
- footer actions **Select All New**, **Clear**, and **Invert**.

The summary bar keeps a running count of projects, sessions, and how many are already imported.

**3. Importing.** One import job runs per project that has selected sessions, with a progress bar and per-project status (pending → importing → done/failed).

**4. Complete.** A summary of sessions imported, projects created vs. updated, and any failures. Imported message counts come out *lower* than the scan's raw-entry estimate — subagent chatter, system reminders, and command echoes are filtered as noise (more on this in [Parsers & ingestion](../architecture/parsers-and-ingestion.md)). Hit **Import more** to loop back, or **Done**.

## The six sources and where they live

Chronicle reads each tool from its standard location. Every location is overridable with an environment variable (in parentheses) if your setup is non-standard — see [Configuration](../reference/configuration.md).

| Tool | Log location | Format |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/` (`CLAUDE_PROJECTS_DIR`) | JSONL |
| Codex | `~/.codex/sessions/` (`CODEX_SESSIONS_DIR`) | JSONL |
| Cursor | workspaceStorage (`CHRONICLE_CURSOR_DIR`) | SQLite |
| OpenCode | `~/.local/share/opencode/opencode.db` (`OPENCODE_DB`) | SQLite |
| Gemini CLI | `~/.gemini/tmp/` (`GEMINI_TMP`) | JSON |
| Copilot Chat | VS Code `workspaceStorage/<hash>/chatSessions/` (`CHRONICLE_VSCODE_DIR`) | JSON |

The full per-tool capability matrix — what's supported, what's partial, and the quirks of each format — lives in [Compatibility](../reference/compatibility.md).

## Read-only, always

Chronicle treats foreign data as untouchable:

- **JSONL and JSON sources** are read directly and never written.
- **SQLite sources (Cursor, OpenCode)** are copied to a temp location — **including the `-wal` and `-shm` files** — before Chronicle opens them. This matters: copying only the `.db` file would yield an empty database, because uncheckpointed writes live in the WAL. Chronicle never opens the live database.

Everything you import lands in Chronicle's own database at `~/.chronicle/chronicle.db`. Deleting a project or session from Chronicle removes it from *that* database only; your source logs stay put and can be re-imported anytime.

> **Local-first:** Import is a one-way read. No log, config, or repo of yours is ever modified by importing, viewing, or sharing a session.

## Re-importing is safe

Re-importing a session is **idempotent**. Under the hood, `replaceSession()` in `server/db.js` deletes the old rows and reinserts them in a single transaction, so you never get duplicates. Two things are worth knowing:

- **A Chronicle rename survives re-import.** If you renamed a session inside Chronicle, that user-set name is read back and preserved across the delete-and-reinsert. (Parsed fields like the tool summary, token usage, and context size *are* re-derived each import.)
- **`context_tokens` only populates on import.** Real context-window usage is captured when a session is imported. If you upgraded Chronicle, re-import or use **Sync Update** to backfill it; otherwise cards fall back to a `~chars/4` estimate.

You can re-import from the wizard, from a project's **Sync Update** menu, or per-session with the sync button (`⇧⌘U`). See [Project management](./project-management.md) for the sync surfaces.

## Gemini and "Needs association"

Gemini CLI doesn't record a real project path in its logs. Chronicle can't key those sessions to a code folder the way it does for the other tools, so on import they land under a virtual path (`gemini-project:<hash>`) and the project page shows a **"Needs association"** banner. Point it at the actual code folder and Chronicle merges the sessions into the matching project — after that, time travel works normally because the Git history is where the code lives. This is covered further in [Project management](./project-management.md).

## Related

- [Compatibility](../reference/compatibility.md) — the full six-tool support matrix and log-location details.
- [Parsers & ingestion](../architecture/parsers-and-ingestion.md) — the normalized event model and how to add a new source.
- [Project management](./project-management.md) — logical projects, association, sync, and the Git pill.
