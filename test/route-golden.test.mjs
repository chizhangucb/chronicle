// Route golden for the shared/usage.ts consolidation (#301).
//
// The consolidation is behaviour-preserving by intent, so the pin is equality
// with what the routes returned BEFORE it: every affected surface (Insights,
// Explore, Content, activity, detectors, waste, the project page, sessions and
// messages) is served over a fixed corpus and deep-compared against
// test/fixtures/route-golden.json, captured on the pre-slice commit.
//
// Determinism, so a committed golden stays true tomorrow:
//   - the corpus carries ABSOLUTE timestamps (never "n days ago"), and every
//     route is asked for the All range (`days` absent → null), so nothing the
//     routes return is derived from the wall clock at test time;
//   - /activity takes its clock from mountActivity({ now }), pinned here;
//   - the projects are /tmp paths, not Git repos, so no commit counts vary;
//   - the timezone is pinned to UTC below. Day/hour buckets are LOCAL by
//     design (server/explore.ts bucketExpr, server/rangeUsage.ts
//     bucketKeyExpr), so an unpinned TZ moves bucket keys and re-splits
//     sessions that straddle a local midnight — the golden was captured in
//     UTC and only reproduces there.
// Regenerate (only when a route's JSON is meant to change) with
// `UPDATE_ROUTE_GOLDEN=1 node --test test/route-golden.test.mjs`.
//
// The corpus deliberately covers every `sessions.usage` dialect the parse path
// has to survive: the stored shape, the legacy pre-TTL-split `cacheWrite` key,
// a session with no usage at all, and a session whose usage string is not JSON.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { withTempDb } from './helpers.mjs';

// Pin the clock's timezone before any route runs (SQLite's 'localtime' and JS
// Date both read process.env.TZ per call — see test/explore.test.mjs, which
// flips it the same way).
process.env.TZ = 'UTC';

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'route-golden.json');
const UPDATE = process.env.UPDATE_ROUTE_GOLDEN === '1';

const HOUR = 3600000;
// A fixed instant in the past, so every bucket key, cutoff and median in the
// golden is a function of the corpus alone.
const NOW = Date.parse('2026-02-10T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

let teardown, server, baseUrl, projectId;

// Assistant + tool rows spaced far enough apart to clear the noise gate, with
// per-message token columns (the in-range share calibration reads these) and a
// couple of tool_result error heads (the detectors/Explore error paths).
function events(startMs, count, model, tokensPerMsg) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const ts = iso(startMs + i * 20 * 60000);
    out.push({ kind: 'assistant', model, ts, text: `assistant reply ${i} over the fixture corpus`,
      input_tokens: tokensPerMsg, output_tokens: Math.round(tokensPerMsg / 2),
      cache_read_tokens: tokensPerMsg * 3, cache_w5m_tokens: tokensPerMsg, cache_w1h_tokens: 0,
      message_id: `msg-${startMs}-${i}`, request_id: `req-${startMs}-${i}` });
    out.push({ kind: 'tool_use', ts, tool_name: i % 3 === 0 ? 'Read' : 'Bash', tool_use_id: `tu-${startMs}-${i}`,
      tool_input: JSON.stringify({ file_path: `/demo/src/file-${i % 4}.ts` }), skill: i % 5 === 0 ? 'review' : null });
    out.push({ kind: 'tool_result', ts, tool_use_id: `tu-${startMs}-${i}`,
      text: i % 4 === 0 ? 'Error: command failed with exit code 1' : `ok ${i}` });
  }
  return out;
}

before(async () => {
  const temp = await withTempDb();
  teardown = temp.teardown;
  const { upsertProject, replaceSession } = temp.dbModule;

  const atlas = upsertProject('/tmp/golden-atlas');
  const orchard = upsertProject('/tmp/golden-orchard');
  projectId = atlas.id;

  // Stored dialect (cacheWrite5m / cacheWrite1h), two models on one session.
  replaceSession(
    { id: 'g-modern', project_id: atlas.id, source: 'claude-code', file_path: '/tmp/g-modern.jsonl',
      started_at: iso(NOW - 72 * HOUR), ended_at: iso(NOW - 68 * HOUR), context_tokens: 120000,
      usage: JSON.stringify({
        'claude-sonnet-5': { input: 12000, output: 3400, cacheRead: 88000, cacheWrite5m: 5100, cacheWrite1h: 900 },
        'claude-opus-4-8': { input: 4000, output: 1200, cacheRead: 21000, cacheWrite5m: 700, cacheWrite1h: 0 },
      }) },
    events(NOW - 72 * HOUR, 12, 'claude-sonnet-5', 400),
  );
  // Legacy pre-TTL-split dialect: `cacheWrite` is billed as a 5m write.
  replaceSession(
    { id: 'g-legacy', project_id: atlas.id, source: 'codex', file_path: '/tmp/g-legacy.jsonl',
      started_at: iso(NOW - 48 * HOUR), ended_at: iso(NOW - 45 * HOUR), context_tokens: 60000,
      usage: JSON.stringify({ 'gpt-5': { input: 9000, output: 2200, cacheRead: 30000, cacheWrite: 1500 } }) },
    events(NOW - 48 * HOUR, 10, 'gpt-5', 250),
  );
  // No usage blob at all: every cell must read zero, not NaN.
  replaceSession(
    { id: 'g-nousage', project_id: orchard.id, source: 'cursor', file_path: '/tmp/g-nousage.jsonl',
      started_at: iso(NOW - 30 * HOUR), ended_at: iso(NOW - 28 * HOUR), usage: null },
    events(NOW - 30 * HOUR, 11, 'claude-sonnet-5', 180),
  );
  // Unparseable usage: the parse path must degrade to {} rather than throw.
  replaceSession(
    { id: 'g-broken', project_id: orchard.id, source: 'opencode', file_path: '/tmp/g-broken.jsonl',
      started_at: iso(NOW - 20 * HOUR), ended_at: iso(NOW - 18 * HOUR), usage: '{not json' },
    events(NOW - 20 * HOUR, 10, 'gemini-2.5-pro', 300),
  );
  // A minor session (short on both axes), so the minor gate is exercised too.
  replaceSession(
    { id: 'g-minor', project_id: orchard.id, source: 'claude-code', file_path: '/tmp/g-minor.jsonl',
      started_at: iso(NOW - 10 * HOUR), ended_at: iso(NOW - 10 * HOUR + 60000),
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 500, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }) },
    events(NOW - 10 * HOUR, 1, 'claude-sonnet-5', 100),
  );

  const app = express();
  const [insights, explore, content, activity, detectors, waste, projects, sessions] = await Promise.all([
    import('../server/routes/insights.ts'), import('../server/routes/explore.ts'),
    import('../server/routes/content.ts'), import('../server/routes/activity.ts'),
    import('../server/routes/detectors.ts'), import('../server/routes/waste.ts'),
    import('../server/routes/projects.ts'), import('../server/routes/sessions.ts'),
  ]);
  insights.mountInsights(app);
  explore.mountExplore(app);
  content.mountContent(app);
  activity.mountActivity(app, { now: NOW });
  detectors.mountDetectors(app);
  waste.mountWaste(app);
  projects.mountProjects(app);
  sessions.mountSessions(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  teardown?.();
});

// `created_at` / `imported_at` are stamped by the DB at seed time, so they are
// the one part of a response that is a function of when the test ran rather
// than of the corpus. Blank them (keeping the key, so a route dropping the
// field still fails) before comparing.
const SEED_STAMPED = new Set(['created_at', 'imported_at']);
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SEED_STAMPED.has(k) ? '<seeded>' : scrub(v)]));
  }
  return value;
}

// Every affected surface, at the All range so nothing is clock-dependent.
function routes() {
  return [
    '/insights',
    '/explore?metric=spend&group=model&rollup=total',
    '/explore?metric=tokens&group=session&rollup=daily',
    '/explore?metric=errors&group=tool&rollup=total',
    '/explore?metric=spend&group=project&subgroup=source&rollup=weekly',
    '/explore?metric=spend&group=source&rollup=monthly',
    '/explore?metric=tokens&group=hour&rollup=daily',
    '/explore?metric=spend&group=subagent&rollup=daily',
    '/explore?metric=spend&group=provider&rollup=hourly',
    '/content',
    '/activity',
    '/detectors',
    '/waste',
    `/projects/${projectId}`,
    '/sessions/minor',
    '/sessions/g-modern/messages',
    '/sessions/g-legacy/messages',
  ];
}

test('every affected route returns the JSON the pre-slice commit returned', async () => {
  const captured = {};
  for (const route of routes()) {
    const res = await fetch(`${baseUrl}${route}`);
    assert.equal(res.status, 200, `${route} did not answer 200`);
    captured[route] = scrub(await res.json());
  }
  if (UPDATE) {
    fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(captured, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  for (const route of routes()) {
    assert.deepEqual(captured[route], golden[route], `${route} changed shape or numbers`);
  }
  assert.deepEqual(Object.keys(captured), Object.keys(golden), 'the golden covers a different route set');
});
