// Regression pin for the feedback-round P0: every windowed engine route
// (insights, per-project analytics, explore, content) must include a session that
// started BEFORE the requested window but ran INTO it (e.g. a session spanning
// midnight into "Today") — the old `COALESCE(s.started_at,'9') >= cutoff` gate dropped
// such a session entirely, which could zero out an entire project's "Today" view. This
// test seeds exactly that fixture (one spanning session + one fully-in-range session)
// and asserts every route returns non-zero windowed results AND that the windowed
// token totals reconcile EXACTLY across insights/projects/explore/content — they all
// read the same server/rangeUsage.ts primitive, so a real implementation can't disagree.
//
// The window is a fixed `days=1` (trailing 24h from "now"), not "since local
// midnight": the P0 code path (overlapGate / rangedUsage) only cares about the
// numeric cutoff, not whether it happens to land on a calendar-midnight boundary, and
// anchoring to `now` (with wide hour-scale margins around the cutoff) keeps this test
// deterministic regardless of what time of day it runs — no local-midnight edge case.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withTempDb } from './helpers.mjs';

const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();
const WINDOW_DAYS = 1; // trailing 24h — exercises the same overlapGate cutoff logic as "Today"

const MODEL = 'claude-sonnet-5';

// Assistant-only events (no human 'user' turns, so every inter-message gap counts
// toward agent_active_ms — see server/durations.ts) spaced hours apart, comfortably
// clearing the noise gate's 5-min-active / 10-message thresholds (server/noiseGate.ts)
// regardless of the exact spacing. `tsOffsetsFromNowMs` are NEGATIVE offsets from `now`
// (e.g. -HOUR = one hour ago).
function spanEvents(tsOffsetsFromNowMs, tokensPerMsg) {
  return tsOffsetsFromNowMs.map((offset, i) => ({
    kind: 'assistant',
    model: MODEL,
    ts: iso(now + offset),
    input_tokens: tokensPerMsg,
    output_tokens: 0,
    text: `assistant reply ${i} for composition char share`,
  }));
}

let dbModule, teardown, insightsModule, exploreModule, contentModule;
let projectId, server, baseUrl;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  insightsModule = await import('../server/insights.ts');
  exploreModule = await import('../server/explore.ts');
  contentModule = await import('../server/content.ts');
  const { mountProjects } = await import('../server/routes/projects.ts');

  const { upsertProject, replaceSession } = dbModule;
  const p = upsertProject('/tmp/window-p0-proj');
  projectId = p.id;

  // spanner: started 30h ago (well before the 24h cutoff), ended 5min ago (well
  // within the window). Under the OLD `started_at >= cutoff` gate this session would
  // be excluded from the window entirely — the P0 this task fixes.
  // 6 messages land 25-28h ago (clearly BEFORE the ~24h cutoff, out of window), 6 land
  // 4-20h ago (clearly AFTER the cutoff, in window) — 10 tokens/msg, so the billed
  // cell's in-range ratio is exactly 6/12 = 0.5. Both halves sit hours clear of the
  // cutoff boundary, tolerating any realistic clock drift between this file's `now`
  // and the server's own `Date.now()` call inside computeInsights/etc.
  const beforeOffsets = [-28 * HOUR, -27 * HOUR, -26.5 * HOUR, -26 * HOUR, -25.5 * HOUR, -25 * HOUR];
  const afterOffsets = [-20 * HOUR, -16 * HOUR, -12 * HOUR, -8 * HOUR, -4 * HOUR, -10 * 60000];
  const spannerEvents = spanEvents([...beforeOffsets, ...afterOffsets], 10);

  replaceSession(
    {
      id: 'spanner', project_id: projectId, source: 'claude-code', file_path: '/tmp/spanner.jsonl',
      started_at: iso(now - 30 * HOUR), ended_at: iso(now - 5 * 60000),
      usage: JSON.stringify({ [MODEL]: { input: 1000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }),
    },
    spannerEvents,
  );

  // today: fully within the window (started 3h ago, ended recently) — a plain
  // control fixture, all 12 messages/tokens in-range, ratio 1.
  const todayOffsets = [-3 * HOUR, -2.5 * HOUR, -2 * HOUR, -1.5 * HOUR, -HOUR, -45 * 60000, -30 * 60000, -20 * 60000, -15 * 60000, -12 * 60000, -9 * 60000, -6 * 60000];
  replaceSession(
    {
      id: 'today', project_id: projectId, source: 'claude-code', file_path: '/tmp/today.jsonl',
      started_at: iso(now - 3 * HOUR), ended_at: iso(now - 6 * 60000),
      usage: JSON.stringify({ [MODEL]: { input: 200, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }),
    },
    spanEvents(todayOffsets, 10),
  );

  // minor: a genuinely minor session — short on BOTH axes (agent_active_ms < 5min
  // AND < 10 messages; the gate is AND, not OR — server/noiseGate.ts) with
  // non-zero usage in-range, to verify the ranged KPI call correctly excludes
  // minor sessions. Two messages 1 min apart => ~1min active. replaceSession
  // recomputes `minor` at insert, so the fixture must actually clear the gate.
  const minorOffsets = [-60 * 60000, -59 * 60000];
  replaceSession(
    {
      id: 'minor', project_id: projectId, source: 'claude-code', file_path: '/tmp/minor.jsonl',
      started_at: iso(now - 60 * 60000), ended_at: iso(now - 59 * 60000),
      usage: JSON.stringify({ [MODEL]: { input: 500, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }),
      minor: 1,
    },
    spanEvents(minorOffsets, 10),
  );

  const app = express();
  mountProjects(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  teardown?.();
});

function sumRangeCells(cells) {
  return cells.reduce((n, c) => n + c.cells.input + c.cells.output, 0);
}

test('computeInsights: includes the spanning session (P0 fix) and returns non-zero windowed totals', async () => {
  const r = await insightsModule.computeInsights(WINDOW_DAYS);
  assert.equal(r.sessions.length, 2, 'both the spanning session and the fully-in-range session must be in the ranged session list');
  assert.ok(r.sessions.some((s) => s.id === 'spanner'), 'the spanning session must not vanish from the window (the P0 bug)');
  assert.ok(r.rangedTokensByModel.length > 0);
  assert.ok(sumRangeCells(r.rangedTokensByModel) > 0, 'windowed token total must be non-zero');
  assert.ok(r.dailySpend.length > 0, 'dailySpend must be non-empty');
  assert.ok(r.hourlySpend != null, 'hourlySpend must be computed (not null) when days<=2');
  assert.ok(r.hourlySpend.length > 0, 'hourlySpend must be non-empty');
});

test('GET /projects/:id?days=1: includes the spanning session and returns non-zero windowed totals', async () => {
  const res = await fetch(`${baseUrl}/projects/${projectId}?days=${WINDOW_DAYS}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessions.length, 2, 'the project session list must include both sessions');
  assert.ok(body.sessions.some((s) => s.id === 'spanner'));
  assert.ok(Array.isArray(body.analytics.rangedTokensByModel));
  assert.ok(sumRangeCells(body.analytics.rangedTokensByModel) > 0);
});

test('computeExplore(group=model, metric=tokens): non-zero, session-inclusive', () => {
  const r = exploreModule.computeExplore({
    scope: { type: 'all' }, days: WINDOW_DAYS, metric: 'tokens', group: 'model', rollup: 'total', topN: 10,
  });
  const row = r.rows.find((x) => x.key === MODEL);
  assert.ok(row, 'the model row must be present');
  const tok = (row.tokensByModel[MODEL]?.input ?? 0) + (row.tokensByModel[MODEL]?.output ?? 0);
  assert.ok(tok > 0, 'Explore token magnitude must be non-zero');
});

test('computeContent(scope=all): non-zero calibrated total', () => {
  const r = contentModule.computeContent({ type: 'all' }, WINDOW_DAYS);
  assert.ok(r.calibratedTotalTokens > 0, 'Content calibrated total must be non-zero');
  assert.ok(r.composition.some((c) => c.tokens > 0));
});

test('windowed token totals reconcile EXACTLY across insights/projects/explore/content', async () => {
  const insightsTotal = sumRangeCells((await insightsModule.computeInsights(WINDOW_DAYS)).rangedTokensByModel);

  const res = await fetch(`${baseUrl}/projects/${projectId}?days=${WINDOW_DAYS}`);
  const projectsTotal = sumRangeCells((await res.json()).analytics.rangedTokensByModel);

  const exploreResult = exploreModule.computeExplore({
    scope: { type: 'all' }, days: WINDOW_DAYS, metric: 'tokens', group: 'model', rollup: 'total', topN: 10,
  });
  const exploreTotal = exploreResult.rows.reduce(
    (n, r) => n + Object.values(r.tokensByModel).reduce((m, c) => m + c.input + c.output, 0), 0,
  );

  const contentTotal = contentModule.computeContent({ type: 'all' }, WINDOW_DAYS).calibratedTotalTokens;

  assert.equal(insightsTotal, projectsTotal, 'insights (global) and projects (scoped to the one project both sessions live in) must agree exactly');
  assert.equal(insightsTotal, exploreTotal, 'insights and explore must agree exactly (both source rangedUsage)');
  assert.equal(insightsTotal, contentTotal, 'insights and content must agree exactly (both source rangedUsage input+output)');

  // Full precision: spanner contributes exactly half its billed 1000 (6/12 in-range
  // messages) + today contributes its full billed 200 = 700. Minor session is excluded.
  assert.equal(insightsTotal, 700);
});

test('minor sessions are excluded from windowed KPI queries', async () => {
  // The insights result excludes minor sessions — this is the baseline.
  const insightsResult = await insightsModule.computeInsights(WINDOW_DAYS);
  const insightsTotal = sumRangeCells(insightsResult.rangedTokensByModel);

  // The projects/:id windowed query must also exclude minor sessions and
  // reconcile exactly with insights.
  const res = await fetch(`${baseUrl}/projects/${projectId}?days=${WINDOW_DAYS}`);
  const projectsResult = await res.json();
  const projectsTotal = sumRangeCells(projectsResult.analytics.rangedTokensByModel);

  // Totals must match: both exclude the minor session (500 tokens).
  assert.equal(projectsTotal, insightsTotal, 'projects windowed KPI must exclude minor sessions and reconcile with insights');
  assert.equal(projectsTotal, 700, 'total must be 700 (spanner 500 + today 200), excluding minor session');
});

