// Pins for the local-only view log (server/viewlog.ts, CHI-325 3a).
//
// The load-bearing properties, in order of how badly a regression would hurt:
//   1. Route PATTERNS only. A stored session id would turn this table into a
//      second copy of the history, which is the one thing it must never be.
//   2. Actor collapse happens at READ time (D5). Collapsing on write is the
//      CHI-307 error made permanent.
//   3. Demo usage is never recorded. Demo is not usage.
//   4. Dwell is capped, so an abandoned tab cannot swamp the readings.
//   5. Writing a row must NOT bump the analytics cache generation. Navigation
//      is what writes rows, so obeying server/cache.ts's "every write path
//      invalidates" rule here would destroy a no-TTL cache on every click.
//
// db.ts binds its handle to CHRONICLE_DATA_DIR at import time, so the temp dir
// is set before any import that reaches it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-viewlog-'));
process.env.CHRONICLE_DATA_DIR = data;
delete process.env.CHRONICLE_DEMO;
delete process.env.CHRONICLE_E2E;
delete process.env.CHRONICLE_AGENT;

const { db } = await import('../server/db.ts');
const {
  recordView, closeView, collapseActor, serverActor, viewLogSummary, clearViewLog,
  pruneViewLog, DWELL_CEILING_MS, RETENTION_DAYS,
} = await import('../server/viewlog.ts');
const { cached, invalidateCache } = await import('../server/cache.ts');

const HUMAN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0 Safari/537.36';
const reset = () => db.exec('DELETE FROM view_log');

test('the route allowlist stores patterns and rejects instances', () => {
  reset();
  assert.ok(recordView({ route: '/session/:id', event: 'visit' }, HUMAN_UA) > 0);
  // The real privacy property: a concrete session id must not be storable.
  assert.equal(recordView({ route: '/session/8f3ad2c1-0000-4000-8000-000000000000', event: 'visit' }, HUMAN_UA), null);
  assert.equal(recordView({ route: '/project/17', event: 'visit' }, HUMAN_UA), null);
  assert.equal(recordView({ route: '/not-a-route', event: 'visit' }, HUMAN_UA), null);
  const rows = db.prepare('SELECT route FROM view_log').all();
  assert.deepEqual(rows.map((r) => r.route), ['/session/:id']);
});

test('unknown events and un-allowlisted actions are dropped', () => {
  reset();
  assert.equal(recordView({ route: '/', event: 'scroll' }, HUMAN_UA), null);
  assert.equal(recordView({ route: '/', event: 'action', detail: 'rage-click' }, HUMAN_UA), null);
  assert.ok(recordView({ route: '/', event: 'action', detail: 'sync-now' }, HUMAN_UA) > 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM view_log').get().c, 1);
});

test('collapseActor: either verdict saying agent wins', () => {
  // The tie breaks toward agent on purpose. A false "human" is the failure that
  // started all of this; a false "agent" only undercounts.
  assert.equal(collapseActor({ actor_client: 'human', actor_server: 'human' }), 'human');
  assert.equal(collapseActor({ actor_client: 'agent', actor_server: 'human' }), 'agent');
  assert.equal(collapseActor({ actor_client: 'human', actor_server: 'agent' }), 'agent');
  assert.equal(collapseActor({ actor_client: 'agent', actor_server: 'agent' }), 'agent');
});

test('both actor signals are stored uncollapsed (D5: re-derivable later)', () => {
  reset();
  // A CDP-driven real browser: the client knows (navigator.webdriver), the
  // server's UA check does not. Storing only the collapse would lose the fact
  // that they disagreed, which is exactly what a future re-tagging needs.
  recordView({ route: '/', event: 'visit', actorClient: 'agent' }, HUMAN_UA);
  const row = db.prepare('SELECT actor_client, actor_server, ua FROM view_log').get();
  assert.equal(row.actor_client, 'agent');
  assert.equal(row.actor_server, 'human');
  assert.equal(row.ua, HUMAN_UA);
  assert.equal(collapseActor(row), 'agent');
});

test('serverActor flags automation UAs and self-identifying harnesses', () => {
  assert.equal(serverActor(HUMAN_UA, {}), 'human');
  assert.equal(serverActor('Mozilla/5.0 HeadlessChrome/141.0', {}), 'agent');
  assert.equal(serverActor('curl/8.7.1', {}), 'agent');
  assert.equal(serverActor('python-requests/2.32', {}), 'agent');
  assert.equal(serverActor(null, {}), 'agent');
  // Our own harnesses self-identify by env even when driving a headed browser
  // whose UA looks human.
  assert.equal(serverActor(HUMAN_UA, { CHRONICLE_E2E: '1' }), 'agent');
  assert.equal(serverActor(HUMAN_UA, { CHRONICLE_AGENT: '1' }), 'agent');
});

test('demo navigation records nothing at all', () => {
  reset();
  assert.equal(recordView({ route: '/', event: 'visit' }, HUMAN_UA, { CHRONICLE_DEMO: '1' }), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM view_log').get().c, 0);
});

test('rows open with a null dwell, and closing caps it at the ceiling', () => {
  reset();
  // Opening on arrival is what makes the visit COUNT reliable; the dwell is
  // filled in later and may legitimately never arrive.
  const a = recordView({ route: '/', event: 'visit' }, HUMAN_UA);
  const b = recordView({ route: '/projects', event: 'visit' }, HUMAN_UA);
  const c = recordView({ route: '/ask', event: 'visit' }, HUMAN_UA);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM view_log WHERE dwell_ms IS NULL').get().c, 3);

  // An abandoned tab: eight hours must read as the ceiling, not as attention.
  assert.equal(closeView(a, 8 * 60 * 60 * 1000), true);
  assert.equal(closeView(b, 4200), true);
  // Nonsense durations leave the row honestly unknown rather than writing a lie.
  assert.equal(closeView(c, -5), false);
  assert.equal(closeView(c, Number.NaN), false);

  const rows = db.prepare('SELECT route, dwell_ms FROM view_log ORDER BY id').all();
  assert.equal(rows[0].dwell_ms, DWELL_CEILING_MS);
  assert.equal(rows[1].dwell_ms, 4200);
  assert.equal(rows[2].dwell_ms, null);
});

test('a second close cannot overwrite the first honest reading', () => {
  // visibilitychange followed by pagehide fires closeOut twice; the later one
  // is measured from the same start and would always be longer.
  reset();
  const id = recordView({ route: '/', event: 'visit' }, HUMAN_UA);
  assert.equal(closeView(id, 3000), true);
  assert.equal(closeView(id, 90000), false);
  assert.equal(db.prepare('SELECT dwell_ms FROM view_log WHERE id = ?').get(id).dwell_ms, 3000);
});

test('closeView refuses to write in demo mode', () => {
  reset();
  const id = recordView({ route: '/', event: 'visit' }, HUMAN_UA);
  assert.equal(closeView(id, 3000, { CHRONICLE_DEMO: '1' }), false);
  assert.equal(db.prepare('SELECT dwell_ms FROM view_log WHERE id = ?').get(id).dwell_ms, null);
});

test('a view-log write does NOT bump the analytics cache generation', () => {
  // server/cache.ts says "every DB write path calls invalidateCache()". This
  // module is the deliberate exception: navigation is what writes a row, so
  // obeying that rule here would invalidate every heavy analytics result on
  // every click and permanently destroy a cache whose only correctness
  // mechanism is invalidation.
  reset();
  let computed = 0;
  const compute = () => { computed++; return 'value'; };
  cached('viewlog-cache-pin', compute);
  assert.equal(computed, 1);
  recordView({ route: '/', event: 'visit' }, HUMAN_UA);
  cached('viewlog-cache-pin', compute);
  assert.equal(computed, 1, 'recordView must not invalidate the analytics cache');
  // Control: a real invalidation still works, so the pin is testing the
  // exception rather than a broken cache.
  invalidateCache();
  cached('viewlog-cache-pin', compute);
  assert.equal(computed, 2);
});

test('the summary collapses at read time and reports a median dwell', () => {
  reset();
  // Three human visits to / with dwells 1s / 5s / 60s, plus one agent visit.
  closeView(recordView({ route: '/', event: 'visit' }, HUMAN_UA), 1000);
  closeView(recordView({ route: '/', event: 'visit' }, HUMAN_UA), 5000);
  closeView(recordView({ route: '/', event: 'visit' }, HUMAN_UA), 60000);
  closeView(recordView({ route: '/', event: 'visit' }, 'HeadlessChrome/141'), 3000);
  closeView(recordView({ route: '/projects', event: 'visit' }, HUMAN_UA), 900);

  const s = viewLogSummary();
  assert.equal(s.rows, 5);
  assert.equal(s.humanRows, 4, 'three / visits plus the /projects visit');
  assert.equal(s.agentRows, 1, 'the headless visit and nothing else counts as agent');

  const home = s.routes.find((r) => r.route === '/');
  assert.equal(home.humanVisits, 3);
  assert.equal(home.agentVisits, 1);
  // Median, not mean: one 60s outlier must not describe the typical visit.
  assert.equal(home.humanDwellMs, 5000);
  // Busiest human surface first.
  assert.equal(s.routes[0].route, '/');
});

test('prune drops rows past the retention window and keeps the rest', () => {
  reset();
  recordView({ route: '/', event: 'visit' }, HUMAN_UA);
  const old = new Date(Date.now() - (RETENTION_DAYS + 5) * 86_400_000).toISOString();
  db.prepare(`INSERT INTO view_log (ts, route, event, actor_client, actor_server)
              VALUES (?, '/projects', 'visit', 'human', 'human')`).run(old);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM view_log').get().c, 2);
  assert.equal(pruneViewLog(), 1);
  const left = db.prepare('SELECT route FROM view_log').all();
  assert.deepEqual(left.map((r) => r.route), ['/']);
});

test('clear removes everything and reports what it removed', () => {
  reset();
  recordView({ route: '/', event: 'visit' }, HUMAN_UA);
  recordView({ route: '/ask', event: 'visit' }, HUMAN_UA);
  assert.equal(clearViewLog(), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM view_log').get().c, 0);
  assert.equal(viewLogSummary().rows, 0);
});

test('the database runs in WAL mode', () => {
  // Added with the view log: a write per navigation against the same
  // synchronous handle that serves heavy analytics reads is exactly what
  // rollback-journal serializes worst.
  const mode = db.prepare('PRAGMA journal_mode').get();
  assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal');
});
