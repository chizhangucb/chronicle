# ADR 0007: `/ask`: a read-only SQLite handle is the security boundary

`/ask` is the one place a model's output is executed. The model gets a single MCP tool, `query({sql})`, over a read-only `node:sqlite` handle: writes, `ATTACH` and `load_extension` fail at the SQLite layer, and the filesystem functions are not compiled in. The `SELECT`-only guard in `server/ask.ts` is defense in depth and clean error messages, never the thing relied on. A SQL parser as the boundary was rejected because it is only as good as the parser and fails silently.

`/ask` spawns headless Claude on the subscription the user already pays for, takes no API key, and is off until enabled in Settings.

## Consequences

- A prompt injection that reaches the model cannot mutate the database, reach the filesystem or attach another database, because the capability is absent rather than filtered.
- The cost surface is built in the temp schema, which stays writable on a read-only main database.
- Results are capped (rows, cell length, response bytes).
- Without the `claude` binary and a login the feature is unavailable. That is the correct failure, not a paid fallback.
- `/ask` is the sole exception to "no LLM calls". Docs and README state the exception rather than claim it away.
