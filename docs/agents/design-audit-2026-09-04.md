# Codebase-design audit: seams, duplicates, dead machinery

Resolves [#183](https://github.com/chizhangucb/chronicle/issues/183) on map #173. Agent-only, excluded from the docs site.
Method: the codebase-design skill's vocabulary (module, interface, seam, depth, the deletion test) run as a harsh audit
over `server/`, `src/`, `shared/`, `scripts/`, `test/`, `bin/`, `website/` at commit `0b868bd`, after the shrink
(#215, #217 to #226) landed. No code moved here. Every finding names who decides: **Chi** when it is a product fact
(does the feature earn its place), **eng** when it is an engineering choice made by an AI session and not a preference.

Line counts at the audit commit: server 8.7K, src 12.8K, shared 0.9K, scripts 0.6K, test 14.6K, bin 0.2K, website 0.2K.

## 1. The seam map

How the code is shaped today, module by module, with a verdict: **deep** (small interface, lots behind it, keep),
**leaky** (callers must know its internals), **shallow** (interface as big as the body), **dead** (no caller).

### Server

| Module | Interface | Verdict | Note |
| --- | --- | --- | --- |
| `db.ts` | `db`, `replaceSession()`, tombstones, `snapshotDb()` | deep, but side-effecting | Opens the DB, runs migrations and two backfills at import time. Every test that touches a route pays for it. |
| `parsers/*` | four different shapes | leaky | claudeCode and codex: `parse*Session(file)` async. opencode: `parseOpencodeSessions(dbPath, dir, ids)` sync. cursor: two entry points. `live.ts` reaches into parser internals (`parseClaudeLine`, `parseAgentTranscriptJsonl`). Source branching repeats in `routes/import-sync.ts`, `live.ts`, `db.ts`. |
| `windowUsage.ts` | `overlapGate()`, `windowedUsage()`, `bucketedUsage()` | deep | The one good windowing primitive. Not used by `detectors.ts`, `waste.ts`, or `activity.ts`'s baseline. |
| `scope.ts` | `scopeClause()`, `minorGate()` | shallow and under-used | The minor gate is spelled out by hand 35 more times across seven files. |
| `insights.ts` | `computeInsights(days)` | leaky | All-scope only. Carries two private TTL caches. Computes `bucketedUsage` twice with identical arguments (`windowedTokensByModel` and `dailySpend` are the same call). |
| `routes/projects.ts` `/projects/:id` | inline | duplicate engine | A fourth analytics engine: the same toolDist / kindDist / activity / errors queries as `insights.ts` with a `project_id` filter. |
| `explore.ts` | `computeExplore(query)` | deep but split-brained | 742 lines. The ranked rows are scaled to in-range share; the time-rollup buckets place whole-session usage at `started_at` unscaled (documented as a follow-up inside the file). Errors are regexed per request here while Insights reads precomputed counts. |
| `content.ts` | `computeContent(scope, days)` | deep | Fine. Shares the calibrate seam. |
| `activity.ts` | `computeActivity(since, days, now)` | leaky | Own `parseUsage`, own `LIVE_WINDOW_MS`, baseline median in UTC days while every other bucket is local time. |
| `detectors.ts`, `waste.ts` | `compute*(days)` | shallow | No Scope, no overlap gate, own time gate. Fine as bodies; wrong seam. |
| `cache.ts` | `cached()`, `invalidateCache()` | deep | Good. But it is one of three caching mechanisms (see F12). |
| `errors.ts` | `ERROR_RE`, `isErrorHead()` | deep, but has a twin | Client copy in `src/session/stats.ts` is a literal paste of the regex. |
| `durations.ts` | `agentActiveMs()`, `engagedMs()` | deep, but has a twin | Client copy in `src/session/stats.ts` with the same 10 min / 90 min caps as literals. |
| `noiseGate.ts` | `isMinorSession()` | shallow | Reads `config.json` with its own reader to dodge an import cycle with `autosync.ts`. |
| `security.ts` | `scanText()`, `scanSession()`, rules CRUD | half dead | `preToolUseCheck()`, `listInterceptions()`, `HIGH_SEVERITY`, the `interceptions` table: no caller. Creates tables at import time, away from `db.ts`. |
| `live.ts` | `attachLiveStream()`, `isLiveCandidate()` | deep | Fine. Imports parser internals. |
| `autosync.ts` | `startAutoSync()`, `runIncrementalSync()`, config read/write | two modules in one | Config read and write live here, so `noiseGate.ts` cannot import them. |
| `ask.ts`, `askDb.ts`, `routes/ask.ts`, `scripts/run-ask.ts`, `scripts/ask-db-mcp.ts` | pure core plus three shells | deep | A real seam: the pure core is tested without a DB or a binary. Three of the five files re-derive the data dir. |
| `planWindows.ts` | `computePlanWindows()` | deep | The one outbound network call in the product. |
| `viewlog.ts` | `recordView()`, summary, prune | deep | Self-instrumentation. ~850 lines across server, route, client hook, tests, e2e. |
| `causality.ts` | `analyzeCausality(sessionId)` | deep | Heuristic read-to-change links. |
| `git.ts` | sync and async twins | duplicate | `commitCountSince` and `commitCountSinceAsync` both live; `assertSafeRepoPath` has no caller. |
| `writeToken.ts` | guard plus one route | deep | Fine. ADR 0009. |
| `dataDir.ts` | `resolveDataDir()` | under-used | Five other files inline `CHRONICLE_DATA_DIR || ~/.chronicle`. |
| `demo/*` | `seedDemo` via the real import path | deep | 575 lines including route and test. |

### Client

| Module | Verdict | Note |
| --- | --- | --- |
| `api.ts` (758 lines) | shallow | Hand-mirrored copies of server row types (`Message` mirrors `MessageRow`, `Session` mirrors `SessionRow`), 26 exported types with no importer, URL builders duplicated between `projectUrl()` and `api.project()`. |
| `i18n.ts` (1228 lines) | product question | zh and ja dictionaries, 498 keys each, 614 `t()` call sites. ~88 keys per language reference nothing in the code any more (Services, Config takeover, Inspector, Library, Interception records, Share management). |
| `windowedUsage.ts` | duplicate shape | `UsageCell` is `server/windowUsage.ts`'s `UsageCells` retyped. |
| `session/stats.ts` | twin | Error regex, active and engaged time, usage parsing: all client copies of server logic. |
| `ProjectDetail.tsx` (849 lines) | god file | Exports `sessionDisplayName` (a copy of `server/activity.ts` `displayName`), pickers and types used by other pages. |
| `insights/anomalyMath.ts` | half used | Five exports, two importers; `priceCellsAtDay`, `buildCostedDays`, `windowStartDay`, `topDimInWindow` reached only inside. |
| `useCachedFetch.ts` | deep | Good. The fourth cache (see F12) but the only client one. |
| `RangeBar.tsx` | fine | `RANGE_OPTIONS`, `coerceRangeKey` exported with no importer. |

### Shared, scripts, tests, bin, website

- `shared/types.ts` `ModelUsage`, `server/windowUsage.ts` `UsageCells`, `server/explore.ts` `ModelUsageCell`, `server/activity.ts` `TokenCell`, `src/windowedUsage.ts` `UsageCell`: five names for one five-field token cell, in two field-name dialects (`cw5m` vs `cacheWrite5m`). `explore.ts` carries an adapter between the dialects.
- `sessions.usage` JSON is parsed by five separate `parseUsage` functions (windowUsage, explore, activity, session/stats, pricing).
- `@shared` alias is used by 11 type imports and relative paths by 12; the gotcha explaining why value imports must be relative is doing the work a single convention would.
- `litellm/` (Python proxy spine), `launchd/`, `scripts/install-jobs.mjs`, `test/litellm-runtime.test.mjs`, `test/litellm-guards.test.mjs`: ~1.7K lines and a python3 requirement in CI for a proxy Chronicle no longer reads (#217).
- Removal pins: `removed-routes`, `routes-after-contract-views`, `cli-removed-inputs`, plus the retired-word half of `repo-shape`: four files, ~580 lines, asserting absences.
- 25 server symbols are exported only so tests can reach them (the skill's "testing past the interface" smell). Listed in §4.
- `bin/chronicle.mjs` and `website/` are fine: small, single purpose, no duplication.

## 2. Findings

Ordered by what to do first. Each: what it is, in plain words, the recommendation, who decides.

### Dead machinery

**F1. Pre-tool-use interception in `security.ts`.** `preToolUseCheck()`, `listInterceptions()`, `HIGH_SEVERITY` and the
`interceptions` table have no caller. They served a hook the shrink removed. Plain words: a burglar alarm wired to a door
that no longer exists. Remove the code, add a `DROP TABLE IF EXISTS interceptions` migration next to the `gate_audit`
one, delete the `Interception records` i18n keys. **eng**, small.

**F2. Unused exports.** 20 server and 30 client symbols are exported with no importer outside tests (§4). Prune in one
pass. **eng**, small.

**F3. Sync/async twins in `git.ts`.** `commitCountSince` and `commitCountSinceAsync` do the same thing; `insights.ts`
uses the async one, `routes/projects.ts` the sync one. Keep one. **eng**, small, folds into F16.

### Duplicated logic (the map ticket's "three error-check copies" and friends)

**F4. One token cell, one usage parser.** Five names for the same five-number cell and five parsers of the same JSON.
Plain words: the app describes "how many tokens of each kind" in five slightly different ways and translates between
them. Put one `UsageCell` type and one `parseUsage()` in `shared/usage.ts`, delete the rest and the explore adapter.
**eng**, medium, touches server and client.

**F5. Server logic with a client twin.** Three pieces of logic are copied by hand into the client and must be kept in
sync by a gotcha: the error heuristic (`errors.ts` vs `session/stats.ts`), active and engaged time (`durations.ts` vs
`session/stats.ts`), the session display name (`activity.ts` vs `ProjectDetail.tsx`). The client needs them for live
sessions that are not stored yet, so they belong in `shared/`. Move all three; delete the gotcha entry. **eng**, small
each.

**F6. Data dir and config.** `dataDir.ts` exists but `noiseGate.ts`, `autosync.ts`, `ask.ts`, `run-ask.ts`,
`ask-db-mcp.ts`, `install-jobs.mjs` each inline the same fallback. Config read and write live in `autosync.ts`, so
`noiseGate.ts` has its own reader to avoid an import cycle. Make `server/config.ts` own the path and read/write;
everything imports it. **eng**, small.

**F7. Gates: minor, scope, range.** The minor-session gate is written out 37 times; `scope.ts` already has it. Time
windowing has three dialects: the overlap gate (insights, explore, content, projects), a bare `m.ts >= cutoff`
(detectors, waste), and `s.started_at >= ?` with UTC days (activity's baseline, which is a real bug: every other bucket
is local time). Make `scope.ts` the one place: `scopeClause`, `minorGate`, `rangeGate`, and have every engine take
`(scope, range)`. **eng**, medium.

**F8. Insights and the project page are one engine.** `routes/projects.ts` `/projects/:id` inlines the same four
aggregate queries as `insights.ts` with a `project_id` filter. Give `computeInsights` a Scope (F7 makes that natural)
and the project route calls it. Also removes the double `bucketedUsage` call in insights. **eng**, medium.

**F9. Explore's two magnitude paths.** Ranked rows are scaled to in-range share; the time-rollup buckets are not, so
the total bar and the stacked chart can disagree for a session that spans the range edge. `bucketedUsage` supports
hour and day only. Extend it to week and month and route the rollup through it; then the per-request error regex in
explore can read the precomputed session counts the way insights does, except for per-tool attribution. **eng**,
medium, the one finding that changes numbers on a surface (sign-off rule applies).

**F10. Client row types mirror server row types by hand.** `src/api.ts` retypes `MessageRow`, `SessionRow`, and the
engine result shapes. Move the row and result types to `shared/` and have both sides import them; `api.ts` shrinks to
the fetch layer. Pick relative imports everywhere and drop the `@shared` alias while there. **eng**, medium.

**F11. Parsers behind one Source interface.** Four parsers, four shapes; the import route, autosync and live each
branch on the source string. A `Source` with `scan()`, `parse()`, `mtime()`, and an optional `tail()` per source makes
those three callers source-agnostic and stops `live.ts` importing parser internals. Adding a fifth tool becomes one
file. **eng**, large, the biggest deepening available.

**F12. Four caches.** The generation cache (`cache.ts`), two private TTL caches in `insights.ts`, a TTL cache in
`ask.ts`, plus the client's stale-while-revalidate. The server ones should be one module with an optional TTL. **eng**,
small.

**F13. Side effects on import.** `db.ts` opens the database and runs migrations when imported; `security.ts` creates
tables; `api.ts` starts autosync. Tests mount routers one by one to dodge this. A `createApp()` factory and a single
schema module fix it. **eng**, medium, unlocks cheaper tests.

### Earn-its-place (Chi decides)

**F14. Two extra UI languages.** Chinese and Japanese dictionaries: 1228 lines, every UI string routed through `t()`,
~18% of keys already orphaned. Plain words: every label on every screen is written three times, and the extra two
copies drift. Options: keep and prune with a test that pins keys to call sites; or drop to English and delete the
toggle. **Chi.**

**F15. The LiteLLM proxy spine.** A Python proxy, its launchd template, an installer script and two test files, plus
python3 in CI, for a spend log Chronicle stopped reading in #217. Plain words: a side project living inside this
repo. Options: delete; or move to its own repo. **Chi.**

**F16. Plan windows calls api.anthropic.com.** The one outbound request in the product, with the operator's Claude
OAuth token, on by default. The README says "no cloud, no telemetry"; the privacy page explains the exception. Options:
keep on by default (then it deserves an ADR, see §3); off by default; remove. **Chi.**

**F17. The view log.** ~850 lines to record which of Chronicle's own screens the operator looked at, readable only in
Settings. It is also why WAL was enabled and why the cache has an exception. Plain words: the app keeps a diary of its
own use, for one reader. Keep or drop. **Chi.**

**F18. Context causality.** Heuristic "the AI read this before changing that" links with confidence tiers, shown as
chips in playback. Keep or drop. **Chi.**

**F19. Demo mode.** 575 lines so a fresh `npx chronicle-cli` shows something. Probably earns it for a public package.
**Chi.**

### Tests

**F20. Removal pins.** Four files assert that retired things stay retired. The retired-word pin in `repo-shape` is
worth keeping (it guards the glossary). The three route and CLI pins can fold into one `removed-surfaces` file, or
retire after one release. **eng**, small.

**F21. Testing past the interface.** 25 server exports exist only for tests. When F4 to F11 deepen a module, write the
new tests at the new interface and delete the ones that reached inside, per the skill's replace-don't-layer rule. Not
its own issue; a line in `docs/contributing/standards.md`.

## 3. ADRs

The seven candidates on #177 are already pinned as ADR 0001 to 0007; 0008 and 0009 came from #182. Nothing in this
audit unpins any of them. New candidates, judged on hard-to-reverse, surprising, real trade-off:

- **Plan windows is the one outbound call** (F16): surprising against the README, a real trade-off (freshness vs
  the no-network promise), only if Chi keeps it. ADR if kept, deletion if not.
- **Shared logic lives in `shared/` and is never copied** (F4, F5, F10): a standards line, not an ADR. It has no
  rejected alternative, just a rule.
- **Engines take a Scope and a Range** (F7, F8): a standards line.
- **UI strings** (F14): if the dictionaries stay, a doc line saying keys are the English string and orphans are
  pinned by a test. Not an ADR.

So: one conditional ADR, three standards lines. The audit did not find a hidden decision worth a new ADR.

## 4. Unused exports (for F2)

Server, no importer outside tests: `activity.ts` TokenCell, TokensByModel, NamedSessionRow · `ask.ts` ASK_CELL_MAX,
ASK_RESP_MAX_BYTES, scanSql, SanitizeOk, SanitizeErr, AskResult, AskEnvelope, normSql, askHistoryPath · `askDb.ts`
distinctModelDays, BuildCostSurfaceResult · `autosync.ts` SyncResultOk/Skipped/Error, autoSyncEnabled · `git.ts`
FileAtResult, assertSafeRepoPath · `live.ts` LiveSessionLike · `parsers/cursor.ts` cursorUserDir · `routes/ask.ts`
askToggleOn · `security.ts` everything under F1 plus SecurityRuleRow, ScanTextResult, BUILTIN_RULES, RuleInput,
ScanMessage, ScannedMessage, ScanSessionResult · `viewlog.ts` ViewLogInput, ViewLogRow · `waste.ts` the four row
types · `windowUsage.ts` UsageBucket · `shared/` CONTEXT_WINDOWS, ANOMALY_DIMENSIONS, DimensionFlag, AnomalyResult,
BudgetPosture, the five `*_DEFINITION` constants in thresholds.

Client: 26 type exports in `api.ts`, every `*Props` interface, `HomeDashboard.tsx` KpiStrip, `RangeBar.tsx`
RANGE_OPTIONS and coerceRangeKey, `useViewLog.ts` routePattern, clientActor, logAction, `writeToken.ts`
resetWriteToken, `anomalyMath.ts` four of five, `charts/ChartWrapper.tsx` CHART_COLORS.

Exported for tests only (F21): `ask.ts` costBasisLabel, stripSqlComments, ASK_HISTORY_MAX, ASK_HISTORY_ROWS,
parseHistory · `autosync.ts` ChronicleConfig, nextDelay, scheduleDebounced · `db.ts` isTombstoned · `demo/corpus.ts`
DEMO_DAYS · `explore.ts` pickRollup · `parsers/claudeCode.ts` collapseWorktree, reduceCwd · `parsers/cursor.ts`
cursorProjectsDir, cursorProjectSlug, clearCursorGlobalCache, parseCursorAgentSessions · `planWindows.ts`
parseClaudePayload · `security.ts` Finding · `viewlog.ts` Actor, RETENTION_DAYS, serverActor · `charts/timeBuckets.ts`
hourKeyOf, monthKeyOf · `reference/definitions.ts` Definition, DEF_BY_ID.

## 5. Second reviewer and reconciliation

Codex (codex-cli 0.146.0, read-only sandbox) was handed the same brief and §1 to §4. Verdict per finding: F1, F3, F6,
F9, F10, F15, F16, F18, F19, F20 confirmed; the rest adjusted; none disputed. Adjustments taken into the findings:

- F2: prune only exports with no production caller; test-only exports are a judgment call, not automatically dead.
- F5: the display-name copies are near, not exact (the client prefixes and shortens the id). Still one function.
- F7: not one blunt `rangeGate()`. Session, message and token windows have different semantics, so the fix is one
  query-context module in `scope.ts` that hands an engine its scope, minor and range fragments together.
- F8: extract the shared aggregates into the engine; the project route keeps its session list and Git data.
- F11: normalise scan and parse first; do not force one live-tail shape on stores that differ (JSONL vs SQLite).
- F12: consolidate the two server TTL helpers only; the client cache stays separate.
- F13: `createApp()` is not enough on its own; database open and migrations must become an explicit call too.
- F17: the view log is also reachable through Ask's read-only handle, not only Settings.
- F21: prefer interface tests when deepening; do not make "no test-only exports" a rule.

Codex added three findings. Two stand, one is settled elsewhere:

**F22. Deleting the original transcript.** `DELETE /sessions/:id/source-file` and `?source=1` on session delete
unlink the tool's own transcript, irreversibly. Plain words: the session manager can erase the file it was built to
read, with no trash. Options: remove the feature and keep only "remove Chronicle's copy"; or move the file to the OS
trash. **Chi**, medium.

**F23. Route contracts have no single owner.** Client reads go through `api.ts`, but `SecurityCheck.tsx` and
`SessionView.tsx` also call `fetch` directly with their own copies of the response shapes. Folded into F10: the shared
response types plus one client fetch module.

Not taken: Codex flagged Ask as breaking the local-only story (the question and query results go to `claude -p`, and
up to 500 turns of history are kept locally). Chi settled Ask in #177 (keep, off by default, subscription only) and
ADR 0007 records the boundary. The history file is worth one line on the privacy page; no new finding.

Codex's top five by value per effort: F1, F6, F3, F15, F22. This audit's ordering agrees on the first three and puts
F4 and F7 next, since they unblock F8, F9 and F11.
