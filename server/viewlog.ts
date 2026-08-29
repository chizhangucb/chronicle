// server/viewlog.ts
// The local-only view log (CHI-325 3a). Why it exists: the CHI-307 merge
// decision had to be made on file mtimes, and they were wrong: the one
// "human" Varde interaction that day was an agent resolving a briefing card.
// So Chronicle records its own usage, actor-tagged, and the next question of
// that shape ("which surfaces earn their space?") gets answered with data.
//
// INVARIANT: this never leaves the machine. It is a SQLite table read only by
// the operator's own Settings block and by /ask (SELECT-only over the same
// db). No outbound path is added anywhere for it. External telemetry stays
// deferred to the go-to-market moment, opt-in (brainstorm Q13).
//
// SCOPE, stated honestly: BROWSER-DRIVEN usage only. Rows are written by a
// client POST, so an agent calling /api/* directly runs none of our JS and
// leaves no row at all. That is a real blind spot, not a tagging failure,
// but it is also not the traffic that would be mistaken for Chi's. Agents
// driving a real browser DO write rows, and those are exactly what the actor
// columns exist to separate.
//
// CACHE EXCEPTION (load-bearing): server/cache.ts opens with "Every DB write
// path calls invalidateCache()". This module is the ONE exception and must
// stay one. Navigation is what writes a view-log row, so bumping the cache
// generation here would invalidate every heavy analytics result on every
// click, permanently destroying a no-TTL cache whose whole correctness model
// is invalidation. View-log rows are not read by any analytics query, so no
// cached result can go stale because of them. Do not add invalidateCache().
import { db } from './db.ts';

export type Actor = 'human' | 'agent';
export type ViewEvent = 'visit' | 'tab' | 'action';

/** A single dwell is capped here (D6). An abandoned tab must read as "15 min",
 *  never as the eight hours between closing the laptop and opening it again;
 *  an uncapped dwell would swamp every real reading in the same average. */
export const DWELL_CEILING_MS = 15 * 60 * 1000;

/** Rolling retention (D8). Pruned on boot, not on write: pruning per row would
 *  put a DELETE scan in the navigation path for no benefit. */
export const RETENTION_DAYS = 180;

/** Events we accept. An unknown event name is dropped rather than stored, so a
 *  stale client cannot widen the schema's vocabulary by sending new strings. */
const EVENTS = new Set<ViewEvent>(['visit', 'tab', 'action']);

/** Key interactions worth recording (D6). An allowlist, not "every click":
 *  the log is meant to answer which surfaces earn their space, and an
 *  open-ended action stream would turn it into behavioral logging of a kind
 *  nobody asked for. Anything not named here is dropped at write time. */
const ACTIONS = new Set([
  'sync-now',
  'cost-basis-flip',
  'briefing-action',
  'import-open',
  'search-open',
  'ask-send',
  'demo-start',
  'demo-exit',
]);

/** Route patterns we accept. A bare allowlist rather than a regex reduction,
 *  so a client that sends an INSTANCE ('/session/8f3a...') is rejected outright
 *  instead of being silently stored. The pattern-not-instance rule is the
 *  privacy property of this table and must fail loud, not degrade. */
const ROUTES = new Set([
  '/',
  '/projects',
  '/project/:id',
  '/session/:id',
  '/modules',
  '/safety',
  '/jobs',
  '/briefing',
  '/memory',
  '/records',
  '/reference',
  '/ask',
]);

/** UA fragments that mean "not a person at a browser". Lowercased compare. */
const AUTOMATION_UA = [
  'headlesschrome',
  'playwright',
  'puppeteer',
  'selenium',
  'webdriver',
  'phantomjs',
  'curl/',
  'wget/',
  'python-requests',
  'node-fetch',
  'undici',
  'go-http-client',
];

export interface ViewLogInput {
  route: string;
  event: ViewEvent;
  detail?: string | null;
  dwellMs?: number | null;
  actorClient?: string | null;
  gesture?: boolean;
}

export interface ViewLogRow {
  id: number;
  ts: string;
  route: string;
  event: string;
  detail: string | null;
  dwell_ms: number | null;
  actor_client: string | null;
  actor_server: string | null;
  ua: string | null;
  gesture: number | null;
}

/**
 * The read-time collapse (D5). Either verdict saying "agent" makes the row an
 * agent row: a false "human" is the failure that started all this, so the tie
 * breaks toward agent. Kept as one exported function so the Settings readout,
 * the tests, and any future /ask query cannot each invent their own rule.
 */
export function collapseActor(row: Pick<ViewLogRow, 'actor_client' | 'actor_server'>): Actor {
  return row.actor_client === 'agent' || row.actor_server === 'agent' ? 'agent' : 'human';
}

/**
 * The server's own verdict on a request. Deliberately narrow: it can only see
 * the UA and the run mode. It does NOT try to infer agency from the absence of
 * a client marker: under this design only a client POST writes a row at all,
 * so "no marker" means a malformed client, not a script.
 */
export function serverActor(ua: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Actor {
  // Our own harnesses self-identify, which is the highest-quality signal in the
  // whole scheme because it is the one we control. CHRONICLE_E2E already marks
  // the Playwright gate's dedicated server (test/e2e/helpers.ts), so it is
  // reused rather than duplicated; CHRONICLE_AGENT is the general escape hatch
  // for any other harness that owns its server.
  //
  // The release walk is NOT covered here: it drives a browser against a server
  // it did not start (the operator's own), so it cannot set the env. It falls
  // through to the UA check below, which catches it as HeadlessChrome. That is
  // why the UA list is not merely a backstop.
  if (env.CHRONICLE_AGENT === '1' || env.CHRONICLE_E2E === '1') return 'agent';
  const s = (ua ?? '').toLowerCase();
  if (!s) return 'agent';
  return AUTOMATION_UA.some((frag) => s.includes(frag)) ? 'agent' : 'human';
}

/** Demo usage is not usage (D6). Checked at write time so no demo row is ever
 *  stored, rather than filtered at read time where a later query could forget. */
function isDemo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHRONICLE_DEMO === '1';
}

/**
 * Record one event on ARRIVAL, returning its row id (or null when the input was
 * rejected: unknown route, event or action). Rejection is never an error the UI
 * surfaces; the log is best-effort and must not be able to break a navigation.
 *
 * Why arrival and not departure: the dwell is only known when a visit ENDS, so
 * the obvious design writes one row at the end carrying both. But a full page
 * load tears down the document, and the closing request races that teardown, so
 * end-only writing silently loses whole visits and the VISIT COUNT (the primary
 * question this table answers) becomes unreliable. Writing on arrival makes the
 * count exact and demotes dwell to best-effort: closeView fills it in later, and
 * a visit whose close was lost keeps a NULL dwell, which reads as "unknown"
 * rather than as a fast bounce.
 */
export function recordView(
  input: ViewLogInput,
  ua: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (isDemo(env)) return null;
  if (!ROUTES.has(input.route)) return null;
  if (!EVENTS.has(input.event)) return null;
  if (input.event === 'action' && !ACTIONS.has(input.detail ?? '')) return null;

  const dwell = typeof input.dwellMs === 'number' && Number.isFinite(input.dwellMs) && input.dwellMs > 0
    ? Math.min(Math.round(input.dwellMs), DWELL_CEILING_MS)
    : null;
  const actorClient: Actor = input.actorClient === 'agent' ? 'agent' : 'human';

  const info = db.prepare(
    `INSERT INTO view_log (ts, route, event, detail, dwell_ms, actor_client, actor_server, ua, gesture)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    input.route,
    input.event,
    input.detail ?? null,
    dwell,
    actorClient,
    serverActor(ua, env),
    (ua ?? '').slice(0, 400) || null,
    input.gesture ? 1 : 0,
  );
  // NO invalidateCache() here. See the cache exception in the module header.
  return Number(info.lastInsertRowid);
}

/**
 * Fill in the dwell for a row opened earlier by recordView. Idempotent-ish by
 * construction: it only ever writes a dwell that is still NULL, so a duplicate
 * close (visibilitychange followed by pagehide, say) cannot overwrite the first
 * honest reading with a longer one measured from the same start.
 */
export function closeView(id: number, dwellMs: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (isDemo(env)) return false;
  if (!Number.isInteger(id) || id <= 0) return false;
  if (!Number.isFinite(dwellMs) || dwellMs <= 0) return false;
  const capped = Math.min(Math.round(dwellMs), DWELL_CEILING_MS);
  const info = db.prepare('UPDATE view_log SET dwell_ms = ? WHERE id = ? AND dwell_ms IS NULL').run(capped, id);
  return Number(info.changes) > 0;
}

export interface ViewLogRouteSummary {
  route: string;
  humanVisits: number;
  agentVisits: number;
  /** Median human dwell in ms, null when no human row on this route carries one. */
  humanDwellMs: number | null;
}

export interface ViewLogSummary {
  rows: number;
  humanRows: number;
  agentRows: number;
  firstTs: string | null;
  lastTs: string | null;
  routes: ViewLogRouteSummary[];
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * The Settings readout (D7). Collapses at read time via collapseActor, and
 * reports the MEDIAN human dwell rather than the mean: one forgotten tab
 * sitting at the 15-minute ceiling would drag a mean somewhere dishonest,
 * while a median describes the typical visit.
 */
export function viewLogSummary(): ViewLogSummary {
  const rows = db.prepare(
    `SELECT id, ts, route, event, detail, dwell_ms, actor_client, actor_server, ua, gesture
     FROM view_log ORDER BY ts ASC`,
  ).all() as unknown as ViewLogRow[];

  const byRoute = new Map<string, { human: number; agent: number; dwells: number[] }>();
  let humanRows = 0;
  for (const r of rows) {
    const actor = collapseActor(r);
    if (actor === 'human') humanRows++;
    let e = byRoute.get(r.route);
    if (!e) { e = { human: 0, agent: 0, dwells: [] }; byRoute.set(r.route, e); }
    if (r.event === 'visit') { if (actor === 'human') e.human++; else e.agent++; }
    if (actor === 'human' && typeof r.dwell_ms === 'number') e.dwells.push(r.dwell_ms);
  }

  return {
    rows: rows.length,
    humanRows,
    agentRows: rows.length - humanRows,
    firstTs: rows.length ? rows[0].ts : null,
    lastTs: rows.length ? rows[rows.length - 1].ts : null,
    routes: [...byRoute.entries()]
      .map(([route, e]) => ({
        route,
        humanVisits: e.human,
        agentVisits: e.agent,
        humanDwellMs: median(e.dwells),
      }))
      .sort((a, b) => b.humanVisits - a.humanVisits || b.agentVisits - a.agentVisits),
  };
}

/** Operator's Clear button (D7). Everything, no filter: a partial clear would
 *  leave the operator unsure what remains, which defeats the point. */
export function clearViewLog(): number {
  const before = (db.prepare('SELECT COUNT(*) AS c FROM view_log').get() as unknown as { c: number }).c;
  db.exec('DELETE FROM view_log');
  return before;
}

/**
 * Rolling retention (D8), run once at boot. Failure must not kill startup: a
 * stale second process holding a write lock at this exact moment just means
 * the old rows survive until the next boot retries.
 */
export function pruneViewLog(retentionDays: number = RETENTION_DAYS): number {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  try {
    const doomed = (db.prepare('SELECT COUNT(*) AS c FROM view_log WHERE ts < ?').get(cutoff) as unknown as { c: number }).c;
    if (doomed > 0) db.prepare('DELETE FROM view_log WHERE ts < ?').run(cutoff);
    return doomed;
  } catch {
    return 0;
  }
}
