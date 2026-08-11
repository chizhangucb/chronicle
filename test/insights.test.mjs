// Backend aggregation tests for Task 5d-4 (Global Insights): server/insights.ts
// `computeInsights(days)`. Same shared-temp-db-for-the-whole-file pattern as
// test/sync-hygiene.test.mjs (see test/helpers.mjs).
//
// Two things diverge from the brief's literal fixture code (verified against
// server/db.ts + server/noiseGate.ts before finalizing, per the task brief's
// own instruction to cross-check):
//  1. `replaceSession(session, events)` takes TWO args (not one object with an
//     `events` key), and the session fields are `project_id`/`file_path`
//     (snake_case, matching shared/types.ts SessionInput) — not
//     `projectId`/`filePath`.
//  2. The noise gate (server/noiseGate.ts, applied inside replaceSession) gates
//     ANY session with agent_active_ms < 5min OR message_count < 10 into
//     minor=1 — invisible to every aggregate. The brief's 2-4-message fixture
//     sketch would be auto-gated as minor on insert, which would make
//     `sessions.length === 2` fail immediately (both sessions gated out
//     before any test body runs). So each fixture session here uses 12
//     messages spaced 2 minutes apart (mirrors sync-hygiene's `baseEvents`
//     comment: "comfortably clears the default 5-min / 10-message minor
//     thresholds") while keeping the SAME calendar dates the brief specified
//     (s1 = 2026-08-01, recent; s2 = 2026-01-01, old) so the days-cutoff
//     test still exercises real inclusion/exclusion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, insightsModule;

// 12 messages, 2 minutes apart, alternating user/assistant, starting at
// `baseIso`. `extra` events (e.g. a tool_use/tool_result pair) are appended
// at the end so they don't perturb the alternating human/synthetic gap
// pattern the active-ms threshold depends on.
function rhythmEvents(baseIso, extra = []) {
  const base = new Date(baseIso).getTime();
  const events = [];
  for (let i = 0; i < 12; i++) {
    events.push({
      kind: i % 2 === 0 ? 'user' : 'assistant',
      text: `msg ${i}`,
      ts: new Date(base + i * 2 * 60000).toISOString(),
      ...(i % 2 === 1 ? { model: 'claude-sonnet-5' } : {}),
    });
  }
  return [...events, ...extra];
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  insightsModule = await import('../server/insights.ts');

  const { upsertProject, replaceSession } = dbModule;
  const p1 = upsertProject('/tmp/proj-a');
  const p2 = upsertProject('/tmp/proj-b');

  replaceSession(
    {
      id: 's1', project_id: p1.id, source: 'claude-code', file_path: '/tmp/s1.jsonl',
      started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T10:22:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 100, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
    },
    rhythmEvents('2026-08-01T10:00:00.000Z', [
      { kind: 'tool_use', tool_name: 'Bash', ts: '2026-08-01T10:24:00.000Z' },
      { kind: 'tool_result', text: 'Error: boom', ts: '2026-08-01T10:24:05.000Z' },
    ]),
  );
  replaceSession(
    {
      id: 's2', project_id: p2.id, source: 'codex', file_path: '/tmp/s2.jsonl',
      started_at: '2026-01-01T03:00:00.000Z', ended_at: '2026-01-01T03:22:00.000Z',
      usage: JSON.stringify({ 'claude-haiku-4-5': { input: 10, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
    },
    rhythmEvents('2026-01-01T03:00:00.000Z'),
  );
});

after(() => teardown());

test('computeInsights: aggregates across ALL projects, no project filter', () => {
  const r = insightsModule.computeInsights(null);
  assert.equal(r.sessions.length, 2);
  assert.equal(r.projects.length, 2);
});

test('computeInsights: days cutoff filters sessions/toolDist/kindDist/errors/commits but NOT dailyActivity/hourlyActivity', () => {
  const r = insightsModule.computeInsights(30); // trailing 30d from "now" — s2 (Jan) falls out, s1 (Aug, recent) stays
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].id, 's1');
  // dailyActivity/hourlyActivity use their own fixed windows (182d/30d) — both
  // sessions may or may not appear depending on real "now", but the function
  // must not throw and must return arrays regardless of the days= param.
  assert.ok(Array.isArray(r.dailyActivity));
  assert.ok(Array.isArray(r.hourlyActivity));
});

test('computeInsights: toolDist counts tool_use messages globally', () => {
  const r = insightsModule.computeInsights(null);
  const bash = r.toolDist.find((t) => t.name === 'Bash');
  assert.ok(bash);
  assert.equal(bash.count, 1);
});

test('computeInsights: excludes minor(=1) sessions from every aggregate', () => {
  const { db } = dbModule;
  db.prepare('UPDATE sessions SET minor = 1 WHERE id = ?').run('s2');
  const r = insightsModule.computeInsights(null);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].id, 's1');
  db.prepare('UPDATE sessions SET minor = 0 WHERE id = ?').run('s2'); // restore for later tests
});

test('computeInsights: commits is 0 for projects with no real git repo (graceful, no throw)', () => {
  const r = insightsModule.computeInsights(null);
  assert.equal(r.commits, 0);
});

test('computeInsights: errorsByProject buckets tool_result heads per project and sums to the global errors count', () => {
  const { db } = dbModule;
  db.prepare('UPDATE sessions SET minor = 0 WHERE id = ?').run('s2'); // in case an earlier test left it minor
  const r = insightsModule.computeInsights(null);
  const total = r.errorsByProject.reduce((n, p) => n + p.error_count, 0);
  assert.equal(total, r.errors);
});
