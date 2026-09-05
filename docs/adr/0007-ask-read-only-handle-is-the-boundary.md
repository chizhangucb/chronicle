# ADR 0007: `/ask`: a read-only SQLite handle is the security boundary

**Status:** Accepted

## Context

`/ask` lets a model answer free-form questions over the session database by writing SQL. It is
the one place in Chronicle where a language model's output is executed, so it needs a boundary
that holds even when the model is wrong, confused, or steered by content it read out of a
transcript it is querying.

The tempting boundary is a SQL parser: inspect the statement, allow `SELECT`, reject
everything else. That boundary is only as good as the parser, and a SQL dialect is a large
surface to get exactly right. `ATTACH`, `PRAGMA`, and extension loading each escape a naive
check, and the failure mode is silent.

The related question is which credentials the feature spends. An API key would make `/ask` a
metered cloud feature in a product whose whole promise is local-first and free.

## Decision

The model is handed one MCP tool, `query({sql})`, over a **read-only `node:sqlite` handle**.
That handle is the security boundary: writes, `ATTACH` and `load_extension` fail at the SQLite
layer, and `node:sqlite` does not compile in the filesystem functions at all.

The `SELECT`-only guard in `server/ask.ts` is defense in depth and a source of clean error
messages. It is explicitly not the thing being relied on.

`/ask` spawns headless Claude and uses the subscription the user already pays for. It never
takes an API key. It is opt-in, off until enabled in Settings.

## Consequences

- A prompt injection that reaches the model cannot mutate the database, reach the filesystem,
  or attach another database, because the capability is absent rather than filtered.
- The cost surface is built in the **temp schema**, which stays writable on a read-only main
  database, so `chronicle.db` is untouched by a query run.
- Results are capped (rows, cell length, total response bytes) so one query cannot exhaust
  memory or flood the model's context.
- `/ask` requires the `claude` binary and a logged-in subscription. Without one the feature is
  simply unavailable, which is the correct failure rather than a paid fallback.
- **`/ask` is the sole exception to "no LLM calls".** The analysis path stays heuristic and
  local; docs and README must state the exception rather than claim it away.
- Each `CREATE` in the cost-surface builder is independently guarded, so a SQLite build
  without `json1` degrades to base tables instead of failing the run.
