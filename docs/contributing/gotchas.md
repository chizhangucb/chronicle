# Gotchas

Traps that have already cost someone a day. Each one is a thing the code cannot tell you by
looking correct.

## Mount an Express app, not a Router

The Vite dev plugin hands the API a raw Node `req`/`res`. An Express **Router** does not
decorate those objects, so `res.json` is `undefined` and every route throws. Mounting a full
Express **application** is what makes the same code run behind Vite and behind
`server/standalone.ts`.

## Node's loader is strip-only, so syntax that emits code is banned

Node 24 removes types at load time. It does not compile. `enum`, `namespace` and parameter
properties (`constructor(private x)`) all need emitted runtime code, so they throw at load even
though `tsc` accepts them. Use `as const` unions instead of enums, and assign fields in the
constructor body.

The failure arrives at runtime, in the file that used the syntax, not from `npm run typecheck`.

## Import specifiers carry the real extension

Once a file is `.ts`, every importer writes `./x.ts`, not `./x.js`. Node does not rewrite the
extension the way a bundler does. Relative imports only, on the server side.

## `diff-tree` reports an empty diff against a merge commit

With default options, `git diff-tree` against a merge produces nothing, so a change that
landed through a merge looks like no change at all. `server/git.ts` passes `-m --first-parent`
in both `fileAt()` and `changedFiles()` so the diff is computed against the mainline. Any new
Git query that diffs a commit needs the same flags.

## Copy the WAL sidecars, or you read a stale database

Cursor and OpenCode store chats in SQLite databases the running editor may still be writing.
In WAL mode the newest writes live in the `-wal` file, so copying only the `.db` yields a
snapshot missing recent rows, and sometimes all of them. The copy must include `-wal` and
`-shm`, and the original is opened read-only or not at all.

This is the single most common way a new SQLite source ships looking empty.

## Long-lived state goes on `globalThis`

Vite's SSR module reload re-evaluates server modules in dev. A watcher, timer or child process
held in a module-level variable is orphaned by that reload rather than replaced, and they
accumulate one per edit. Auto-sync's watchers and timers and the live-tail watchers live on
`globalThis` for exactly this reason.

## One API call spans several transcript lines

Claude Code splits one API response's content blocks across several JSONL lines: an empty
`thinking` block, then text, then `tool_use`. **Each line repeats the full `usage` payload.**
Summing usage per line multiplies the real cost by the number of blocks.

Chronicle attaches a call's tokens to exactly one row, which is why summing the per-message
token columns is correct. `message_id` and `request_id` are the per-call identity if you need
to regroup or verify.

## The tool-result error heuristic has a client twin

`server/errors.ts` is the one server-side copy, imported by everything that needs it. But
`isErrorResult` in `src/SessionView.tsx` is a separate implementation of the same rule. Change
one and change the other, or the error counts on a session diverge from the error counts in
Insights.

The convention both follow: test only the first 200 characters of the result.

## Live messages use `seq` from 1,000,000

Streamed messages exist only in client state until the session is re-imported, and they use a
`seq` starting at 1,000,000 so they cannot collide with stored rows. Code that assumes `seq` is
dense or small will misbehave on a live session.

## Re-import deliberately preserves two things

`replaceSession()` is a delete-and-reinsert, which is what makes import idempotent. Two fields
survive on purpose: a Chronicle rename, and a session that was promoted out of the minor
bucket. Both are user intent, and dropping either means every background sync silently undoes
the user's action.

Adding a third user-authored field means adding it to that carry-over, or it evaporates on the
next sync.

## Schema changes are `try`/`catch` ALTERs

There is no migration framework and no version table. Migrations are
`try { db.exec('ALTER TABLE ...') } catch {}` lines that add a column on the first boot after
an upgrade and no-op forever after. This means a migration cannot be ordered against another
one, cannot be rolled back, and must be additive. Anything that needs more than a new column
needs a plan, not another line.

## Detector order in `security.ts` is load-bearing

`db_conn` runs before `email` and `password` so a connection string redacts as one span
instead of being shredded into separate matches. Reordering the detectors changes what a
redacted export looks like. Overlaps resolve by priority: allow rules first, then custom rules,
then built-ins, then earliest match.

## Every write path must invalidate the cache

`server/cache.ts` is generation-keyed with no TTL, so correctness comes from invalidation, not
expiry. A new write path that does not call `invalidateCache()` serves stale analytics
indefinitely, and the bug looks like a UI that will not refresh.

## Ranging is overlap, not a start-time cutoff

A session belongs to a time window when its activity span overlaps the window. The obvious
implementation, filtering on `started_at >= cutoff`, drops a long session that began before the
range and ran into it. `server/rangeUsage.ts` is the shared primitive; ranged routes use
it rather than writing their own cutoff.

## Client libraries are `devDependencies`

Only genuine server-runtime dependencies belong in `dependencies`. Vite bundles React,
Recharts, `wouter`, `diff` and the Radix packages into `dist/` at build time, and the published
package ships only `bin/`, `dist/` and `dist-server/`. Putting a client library in
`dependencies` adds weight to every user's install for nothing.

Check the rule before you add a package: `package.json` currently carries a couple of
client-only libraries in `dependencies` that predate the rule, so the existing split is not a
reliable example to copy.

## The Git pill is uncached on purpose

`repoInfo()` runs `git` on every `/api/projects` call, so the project card's branch and commit
count are always live. If the pill shows a feature branch after a merge, the checkout really is
still on that branch. That is the pill working, not a cache bug.
