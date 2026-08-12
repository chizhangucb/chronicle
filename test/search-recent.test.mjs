// PR2 (Home ledger): the empty-query "recent" branch of GET /api/search must
// return the LAST ~50 non-minor sessions and paginate via `offset` (lazy
// scroll appends the next 50). Same shared-temp-db-for-the-whole-file pattern
// as test/insights.test.mjs (see test/helpers.mjs): CHRONICLE_DATA_DIR is set
// before db.ts is imported, so every module binds to the one temp DB.
//
// Unlike the aggregation tests (which call an exported function directly), the
// recent-limit/offset logic lives inside the Express route handler, so this
// test mounts the real route on an ephemeral express server and drives it over
// HTTP — exercising query-param parsing (offset) and the response shape end to
// end, not a re-implementation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withTempDb } from './helpers.mjs';

const SESSION_COUNT = 55;
const BASE = new Date('2026-08-01T00:00:00.000Z').getTime();

let dbModule, teardown, server, baseUrl;

// 12 messages, 2 minutes apart, alternating user/assistant — comfortably clears
// the default 5-min / 10-message minor gate (mirrors insights.test.mjs), so the
// seeded sessions are all non-minor and DO surface in "recent".
function rhythmEvents(baseMs) {
  const events = [];
  for (let i = 0; i < 12; i++) {
    events.push({
      kind: i % 2 === 0 ? 'user' : 'assistant',
      text: `msg ${i}`,
      ts: new Date(baseMs + i * 2 * 60000).toISOString(),
      ...(i % 2 === 1 ? { model: 'claude-sonnet-5' } : {}),
    });
  }
  return events;
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  const { upsertProject, replaceSession } = dbModule;
  const { mountSearch } = await import('../server/routes/search.ts');

  const p = upsertProject('/tmp/proj-recent');
  // Session i starts 1 hour apart, so ORDER BY COALESCE(ended_at, started_at)
  // DESC yields s54, s53, … s00. Zero-padded id keeps a stable label mapping.
  for (let i = 0; i < SESSION_COUNT; i++) {
    const start = BASE + i * 3600000;
    const id = `s${String(i).padStart(2, '0')}`;
    replaceSession(
      {
        id, project_id: p.id, source: 'claude-code', file_path: `/tmp/${id}.jsonl`,
        started_at: new Date(start).toISOString(),
        ended_at: new Date(start + 22 * 60000).toISOString(),
      },
      rhythmEvents(start),
    );
  }

  const app = express();
  mountSearch(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  teardown?.();
});

async function getRecent(offset) {
  const url = offset == null ? `${baseUrl}/search` : `${baseUrl}/search?offset=${offset}`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return res.json();
}

test('empty query returns the last 50 sessions, newest first', async () => {
  const body = await getRecent();
  assert.equal(body.recent, true);
  assert.equal(body.results.length, 50, 'recent branch caps at 50');
  // Newest is s54 (highest start); the 50-cap drops the 5 oldest (s00..s04).
  assert.equal(body.results[0].id, 's54');
  assert.equal(body.results[49].id, 's05');
});

test('offset=50 returns the next batch (the older tail)', async () => {
  const body = await getRecent(50);
  assert.equal(body.recent, true);
  assert.equal(body.results.length, SESSION_COUNT - 50, 'remaining 5 sessions');
  assert.equal(body.results[0].id, 's04');
  assert.equal(body.results[4].id, 's00');
});

test('ordering is stable & non-overlapping across the offset boundary', async () => {
  const [first, second] = await Promise.all([getRecent(0), getRecent(50)]);
  const firstIds = first.results.map((r) => r.id);
  const secondIds = second.results.map((r) => r.id);
  // strictly descending by COALESCE(ended_at, started_at)
  const tsOf = (r) => new Date(r.ts).getTime();
  for (let i = 1; i < first.results.length; i++) {
    assert.ok(tsOf(first.results[i - 1]) >= tsOf(first.results[i]), 'page 1 descending');
  }
  // no id appears in both pages
  assert.equal(new Set([...firstIds, ...secondIds]).size, firstIds.length + secondIds.length);
});
