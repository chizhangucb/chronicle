# Skills Hub

Import an agent skill once and use it everywhere: Chronicle stores every skill in one central directory and distributes it to each tool via symlinks, so a single real file backs Claude Code, Cursor, Codex, and Gemini at the same time.

Agent skills — a `SKILL.md` plus its supporting files — have the same fragmentation problem as MCP servers. Copy a skill into `~/.claude/skills`, then again into `~/.cursor/skills`, and now you maintain two divergent copies. The Skills Hub fixes this the way a package manager does: one canonical copy in central storage, symlinked out to each tool. Edit the central file and every tool sees the change; a skill you found in one tool becomes available in all of them. It's the same **Takeover → Centralize → Distribute** pattern as the [MCP Hub](./mcp-hub.md), and it is **strictly additive** — Chronicle never overwrites a skill you already have, and only ever removes symlinks it created itself.

> **Local-first:** scanning, importing, tags, and ratings all happen on your machine. The one network action is an explicit **GitHub import** of a public repo you choose; nothing about your skills is uploaded.

## How distribution works

The central store lives at **`~/.chronicle/skills/`** (`CENTRAL_SKILLS` in `server/skills.js`). Importing a skill copies its directory there, and *distributing* it creates a **symlink** from each tool's skill directory back to that one central copy:

```
~/.chronicle/skills/my-skill/          ← the one real directory
  SKILL.md
  ...
~/.claude/skills/my-skill  → ~/.chronicle/skills/my-skill   (symlink)
~/.cursor/skills/my-skill  → ~/.chronicle/skills/my-skill   (symlink)
```

Because the tools read through symlinks, there is exactly **one file to edit** and no copies to keep in sync. Chronicle refuses to replace a real directory or a foreign symlink when linking, and when unlinking it removes *only* a link that points at its own central copy — a real skill directory in a tool folder is never touched. On Windows it uses junctions (which don't need admin rights) instead of directory symlinks.

Distribution targets: `~/.claude/skills`, `~/.cursor/skills`, `~/.codex/skills`, `~/.gemini/skills`.

## Scan & import

Open **Skills Hub → Scan & import** to sweep your machine for skills. Chronicle scans the standard tool directories plus the `~/.agents/skills` convention dir, parses each `SKILL.md` frontmatter for `name` and `description`, and classifies what it finds:

| Status | Meaning |
| --- | --- |
| **importable** | A real skill with a valid `SKILL.md`, not yet in central storage. |
| **managed** | Already a symlink into Chronicle's central store — nothing to do. |
| **duplicate** | A skill with this name already exists centrally. |
| **broken** | No `SKILL.md`, or a dangling symlink. |

Click **Import** on a source group to copy its importable skills into central storage. Originals are left untouched (the import dereferences and copies), and a name collision is disambiguated with a numeric suffix (`my-skill-2`). Once imported, a skill appears in the **Library**.

## The Library

The Library is a grid of skill cards with:

- **Search** across name, description, and tags.
- **Link status per tool** — a pill for each of the four tools showing 🔗 linked, 📁 real directory (a non-Chronicle skill already there), ⚠️ foreign link, or · none. Click a pill to link or unlink that tool in place.
- **Local-only tags and star ratings** — organize and rank your skills. These live in Chronicle's database and are **never uploaded** anywhere.
- A **detail view** showing the central path, the file list, the rendered `SKILL.md`, version history, and — for GitHub-imported skills — an upstream check.

## GitHub import

Import skills straight from a public repository (**Skills Hub → Scan & import → GitHub**). Give it a public HTTPS repo URL, an optional branch (default `main`), and an optional subpath. Chronicle:

1. **Shallow-clones** the repo (`git clone --depth 1 --branch …`) into a temp dir.
2. Records the exact **commit SHA** it cloned.
3. **Walks the tree** (up to five levels deep, skipping `.git` and `node_modules`) for every directory containing a `SKILL.md`.
4. **Imports each** into central storage, stamping it with the repo URL, branch, and SHA, and taking a permanent snapshot.
5. Deletes the temp clone.

Later, **Check upstream** on a GitHub-imported skill runs `git ls-remote` (no clone) to compare your recorded SHA against the current branch tip. If the upstream has moved, re-import to pull the new version.

## Version history

Every imported skill has a rolling version history under **`~/.chronicle/snapshots/`**, so edits and upstream updates are recoverable:

- **`imported`** snapshots are taken at import and **kept permanently**.
- **`fs_change`** snapshots are taken automatically when you edit the central copy — a filesystem watcher on `~/.chronicle/skills/` debounced 500 ms per skill — and kept as a **rolling 50** per skill.
- Identical-content snapshots are **deduplicated** by hash, so untouched saves don't pile up.

The detail view's **Version history** timeline lists snapshots newest-first with their trigger, hash, and size. **Restore** rolls the central copy back to any snapshot — and snapshots the current state first, so a restore is itself undoable. Because the tools point at the central copy through symlinks, a restore takes effect everywhere without re-linking.

## The pattern, end to end

1. **Takeover** — scan your tool directories (and public GitHub repos) and import skills into one central store.
2. **Centralize** — search, tag, rate, snapshot, and restore in one place; edit one real file per skill.
3. **Distribute** — symlink each skill out to the tools that should have it. Additive by design: nothing you already had is overwritten, and removing a skill from the hub only removes Chronicle's own links.

For the store layout, the symlink-fanout implementation, and the snapshot engine internals, see the architecture notes below.

## Related

- [MCP Hub](./mcp-hub.md) — the same Takeover → Centralize → Distribute pattern applied to MCP servers.
- [Security and sharing](./security-and-sharing.md) — redaction, the pre-tool-use guard, and safe share links.
- [MCP & Skills internals](../architecture/mcp-and-skills-internals.md) — the central store, symlink fanout, and snapshot/version-history engine.
