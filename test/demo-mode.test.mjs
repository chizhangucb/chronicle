// Pins for full-product demo mode (CHI-325 3c, decision D9/D13).
//
// The properties that matter, in order:
//   1. Demo makes NO outbound call. Plan windows are the only outbound path in
//      Chronicle, and a stranger evaluating the product must not cause a
//      request to Anthropic. This is a hard requirement, not a nicety.
//   2. Demo never touches the operator's real data. The data dir is under the
//      OS temp dir, and ~/.chronicle is neither read nor written.
//   3. The corpus is deterministic, so a demo screenshot today matches one
//      taken tomorrow and visual regressions are signal rather than noise.
//   4. The corpus is deep enough that every surface has something to show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { demoSessions, DEMO_DAYS } = await import('../server/demo/corpus.ts');
const { demoDataDir } = await import('../server/demo/seed.ts');
const { writeDemoSession } = await import('../server/demo/transcripts.ts');

test('demo mode makes NO outbound call for plan windows', async () => {
  // The guard is checked before any credential read or fetch. Proven by
  // replacing global fetch with a throwing stub: if computePlanWindows reaches
  // the network at all under demo, this fails loudly.
  const realFetch = globalThis.fetch;
  const prevDemo = process.env.CHRONICLE_DEMO;
  globalThis.fetch = () => { throw new Error('demo mode went outbound'); };
  process.env.CHRONICLE_DEMO = '1';
  try {
    const { computePlanWindows } = await import('../server/planWindows.ts');
    const res = await computePlanWindows();
    assert.equal(res.accounts.length, 2, 'demo shows a Claude and a Codex account');
    assert.equal(res.claudeUnauthed, false);
    assert.ok(res.accounts.every((a) => a.windows.length > 0));
  } finally {
    globalThis.fetch = realFetch;
    if (prevDemo === undefined) delete process.env.CHRONICLE_DEMO;
    else process.env.CHRONICLE_DEMO = prevDemo;
  }
});

test('the demo data dir is under the OS temp dir, never ~/.chronicle', () => {
  const dir = demoDataDir();
  assert.ok(dir.startsWith(os.tmpdir()), `demo dir escaped the temp dir: ${dir}`);
  assert.ok(!dir.includes(path.join(os.homedir(), '.chronicle')), 'demo must never point at the real data dir');
});

test('the demo data dir is keyed by DAY, so a cached demo cannot go stale', () => {
  // A cache with no date in the key would keep serving a database whose newest
  // session ages out of the Today window, which is the exact failure that made
  // committing dated transcripts the wrong call (D13).
  const today = demoDataDir(new Date('2026-08-27T12:00:00'));
  const tomorrow = demoDataDir(new Date('2026-08-28T12:00:00'));
  assert.notEqual(today, tomorrow);
  assert.equal(today, demoDataDir(new Date('2026-08-27T23:59:00')));
});

test('the corpus is deterministic', () => {
  const a = demoSessions();
  const b = demoSessions();
  assert.equal(a.length, b.length);
  assert.deepEqual(a.map((s) => s.sessionId), b.map((s) => s.sessionId));
  assert.deepEqual(a.map((s) => `${s.model}|${s.cwd}|${s.turns}`), b.map((s) => `${s.model}|${s.cwd}|${s.turns}`));
});

test('the corpus is deep and varied enough for every surface', () => {
  const specs = demoSessions();
  assert.ok(specs.length > 100, `expected a substantial corpus, got ${specs.length}`);

  // 90d window and a month-over-month budget projection both need real depth.
  assert.ok(Math.max(...specs.map((s) => s.daysAgo)) >= DEMO_DAYS - 7);
  // Today must not be empty, or the default window opens blank.
  assert.ok(specs.some((s) => s.daysAgo === 0), 'no session lands today');

  // Vendor spread: the [project|provider] toggle is flat without it.
  const models = new Set(specs.map((s) => s.model));
  assert.ok(models.size >= 5, `expected vendor variety, got ${[...models].join(', ')}`);
  assert.ok(models.has('gpt-5') && models.has('gemini-2.5-pro'), 'needs non-Anthropic vendors');

  // Project spread for the busiest-projects table and the stacked chart.
  assert.equal(new Set(specs.map((s) => s.cwd)).size, 4);

  // A deliberate spike, so the anomaly tile has a flagged day to point at.
  const cost = (s) => s.usage.input_tokens + s.usage.output_tokens;
  const peak = Math.max(...specs.map(cost));
  const median = specs.map(cost).sort((a, b) => a - b)[Math.floor(specs.length / 2)];
  assert.ok(peak > median * 4, 'the corpus has no spike, so no day is ever flagged');

  // Quiet days, so "active days" differs from "days" and $/active-day is not
  // just $/day under another name.
  const days = new Set(specs.map((s) => s.daysAgo));
  assert.ok(days.size < DEMO_DAYS, 'every single day is active, so the honesty stats collapse');
});

test("today's demo sessions land after local midnight, never yesterday or the future", () => {
  // Found by rebuilding the demo just after midnight: `now - 3h` put every
  // "today" session on YESTERDAY, so the console opened on an empty Today
  // window reading $0 and 0 sessions. A demo whose default view is empty is
  // worse than no demo. Swept across the clock rather than at one time.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-demo-tx-'));
  const spec = {
    sessionId: 'demo-today', model: 'gpt-5', cwd: '/demo/atlas-api',
    daysAgo: 0, turns: 12, promptText: 'x',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  for (const hour of [0, 1, 2, 3, 9, 13, 23]) {
    const now = new Date();
    now.setHours(hour, 12, 0, 0);
    const nowMs = now.getTime();
    const midnight = new Date(nowMs); midnight.setHours(0, 0, 0, 0);

    const file = writeDemoSession(dir, spec, nowMs);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const stamps = lines.map((l) => Date.parse(l.timestamp));
    assert.ok(
      Math.min(...stamps) >= midnight.getTime(),
      `at ${hour}:00 a session started before local midnight (fell onto yesterday)`,
    );
    assert.ok(
      Math.max(...stamps) <= nowMs,
      `at ${hour}:00 a session ran into the future`,
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the corpus is synthetic: no real project names or paths', () => {
  // chronicle is a PUBLIC repo and the fixture floor is synthetic-only.
  for (const s of demoSessions()) {
    assert.ok(s.cwd.startsWith('/demo/'), `demo cwd escaped the synthetic namespace: ${s.cwd}`);
    assert.ok(!s.cwd.includes(os.homedir()), 'a real home path leaked into the corpus');
  }
});
