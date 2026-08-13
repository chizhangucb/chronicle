// Explore hourly rollup must always render at hourly granularity — no silent
// coarsening to daily when the requested window's bucket count exceeds the
// legibility cap (ROLLUP_BUCKET_CAP=90). Windowing a dense hourly series is
// the CLIENT's job (a Recharts <Brush> defaulting to the last 72 buckets),
// not the server's — see records/design/… spec §2.4 / task-10 brief.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, explore, otherProjectId;

// 12 alternating user/assistant events over 22 minutes — same shape as
// test/explore.test.mjs's `rhythmEvents` — so each session clears BOTH
// noiseGate.isMinorSession thresholds (>=10 messages, >=5min agent-active)
// and lands in the main ledger rather than the minor-sessions bucket, which
// minorGate would otherwise exclude from every 'all'-scope aggregate below.
function rhythmEvents(baseIso, model = 'claude-sonnet-5') {
  const base = new Date(baseIso).getTime();
  const events = [];
  for (let i = 0; i < 12; i++) {
    events.push({
      kind: i % 2 === 0 ? 'user' : 'assistant',
      text: `msg ${i}`,
      ts: new Date(base + i * 2 * 60000).toISOString(),
      ...(i % 2 === 1 ? { model, input_tokens: 10, output_tokens: 5 } : {}),
    });
  }
  return events;
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession } = dbModule;
  const proj = upsertProject('/tmp/proj-hourly');

  // One message per hour for the last 168 hours (7 full days), all strictly
  // after `days=7`'s cutoff and strictly before "now" — so every hour lands
  // in its own distinct bucket and none is dropped at either edge. kind:
  // 'assistant' (not 'user') so isHumanPrompt() doesn't zero out every
  // inter-message gap — an all-human-prompt session computes agent_active_ms
  // = 0, which trips isMinorSession's 5-min floor and the minor-session
  // bucket gets excluded by minorGate for scope 'all', silently returning 0
  // buckets regardless of the rollup fix under test.
  //
  // 30-minute safety margin off the oldest edge: 168h is EXACTLY the
  // `days=7` cutoff, so the oldest event's `ts` (computed here, at fixture
  // build time) can land a few ms earlier than `cutoff` (computed later,
  // inside computeExplore() at assertion time) and get excluded by the
  // `started_at >= cutoff` filter — silently zeroing every row (a real bug
  // this test tripped over, not a hypothetical).
  const now = Date.now();
  const oldestMs = now - (167 * 3600000 + 30 * 60000); // 167.5h ago
  const events = [];
  for (let i = 0; i < 168; i++) {
    events.push({
      kind: 'assistant', text: `hourly msg ${i}`, model: 'claude-sonnet-5',
      input_tokens: 10, output_tokens: 5,
      ts: new Date(oldestMs + i * 3600000).toISOString(),
    });
  }
  replaceSession(
    { id: 'sHourly', project_id: proj.id, source: 'claude-code', file_path: '/tmp/sHourly.jsonl',
      started_at: new Date(oldestMs).toISOString(),
      ended_at: new Date(oldestMs + 167 * 3600000).toISOString() },
    events,
  );

  // ---- "Other" segment math fixture (Step 4) ----
  // days:null (no cutoff) below, so this can use fixed dates like the rest
  // of the explore test suite — no clock-drift bookkeeping needed here.
  // topN=3 over 7 distinct tools across 2 days: Bash/Grep/Read make top-3 by
  // RANGE total (Bash 5+2=7, Grep 1+6=7, Read 4+0=4); Write/Edit/Glob/WebFetch
  // fold into 'Other'. Chosen so day 1 and day 2 each mix top-3 and
  // folded-out tools, and neither day's Other total is zero — a bug that
  // zeroes Other in one bucket but not the other wouldn't be caught by a
  // fixture where only one day has overflow tools.
  const proj2 = upsertProject('/tmp/proj-other');
  otherProjectId = proj2.id;
  const toolEvents = (day, counts) => {
    const events2 = [];
    let cursor = new Date(`${day}T09:00:00.000Z`).getTime();
    for (const [tool, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        events2.push({ kind: 'tool_use', tool_name: tool, tool_use_id: `${day}-${tool}-${i}`, ts: new Date(cursor).toISOString() });
        cursor += 60000;
      }
    }
    return events2;
  };
  // Interleaved assistant turns (not all-human) so agent_active_ms clears
  // isMinorSession's floor — same reasoning as the hourly fixture above.
  const assistantEvents = (day) => Array.from({ length: 8 }, (_, i) => ({
    kind: 'assistant', text: `msg ${i}`, model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 5,
    ts: new Date(new Date(`${day}T08:00:00.000Z`).getTime() + i * 120000).toISOString(),
  }));
  replaceSession(
    { id: 'sOther', project_id: proj2.id, source: 'claude-code', file_path: '/tmp/sOther.jsonl',
      started_at: '2026-08-01T08:00:00.000Z', ended_at: '2026-08-02T10:00:00.000Z' },
    [
      ...assistantEvents('2026-08-01'),
      ...toolEvents('2026-08-01', { Bash: 5, Read: 4, Write: 3, Edit: 2, Grep: 1 }),
      ...assistantEvents('2026-08-02'),
      ...toolEvents('2026-08-02', { Bash: 2, Grep: 6, Glob: 3, WebFetch: 1 }),
    ],
  );

  // ---- group=session fixture (Task 16) ----
  // Three sessions with token cost DESCENDING sA > sB > sC, and each
  // exercising a different rung of the sessionDisplayName precedence (name →
  // summary → first_prompt), so "ranked by token cost with names" is
  // testable end-to-end: ranking order proves the sessions.usage sourcing,
  // and the three distinct label rungs prove the fallback chain server-side.
  const proj3 = upsertProject('/tmp/proj-sessgroup');
  replaceSession(
    { id: 'sSessA', project_id: proj3.id, source: 'claude-code', file_path: '/tmp/sSessA.jsonl',
      started_at: '2026-08-05T09:00:00.000Z', ended_at: '2026-08-05T09:30:00.000Z',
      name: 'Renamed Session A', summary: 'auto-summary A (should lose to name)',
      first_prompt: 'first prompt A',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-05T09:00:00.000Z'),
  );
  replaceSession(
    { id: 'sSessB', project_id: proj3.id, source: 'claude-code', file_path: '/tmp/sSessB.jsonl',
      started_at: '2026-08-05T10:00:00.000Z', ended_at: '2026-08-05T10:30:00.000Z',
      summary: 'Auto Summary B', first_prompt: 'first prompt B',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 200, output: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-05T10:00:00.000Z'),
  );
  replaceSession(
    { id: 'sSessC', project_id: proj3.id, source: 'claude-code', file_path: '/tmp/sSessC.jsonl',
      started_at: '2026-08-05T11:00:00.000Z', ended_at: '2026-08-05T11:30:00.000Z',
      first_prompt: 'first prompt C (no name, no summary)',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 50, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-05T11:00:00.000Z'),
  );

  // Non-claude-source sessions (code review finding): only claudeCode.ts
  // writes `sessions.usage` at import — codex/cursor/opencode never do — so
  // group=session's EXACT_USAGE_GROUPS override must not silently zero their
  // Tokens/Spend next to a real nonzero Requests count (reads as a bug).
  //
  // sSessD mirrors codex: no `usage` field, but its per-message events DO
  // carry input_tokens/output_tokens (codex.ts attaches real per-message
  // token_count data) — the fallback should surface those real numbers.
  replaceSession(
    { id: 'sSessD', project_id: proj3.id, source: 'codex', file_path: '/tmp/sSessD.jsonl',
      started_at: '2026-08-05T12:00:00.000Z', ended_at: '2026-08-05T12:30:00.000Z',
      first_prompt: 'codex prompt D' },
    rhythmEvents('2026-08-05T12:00:00.000Z', 'gpt-5-codex'),
  );
  // sSessE mirrors cursor/opencode: no `usage` field AND no per-message token
  // fields at all (those parsers never populate token data anywhere) — the
  // fallback has nothing to recover, so Tokens/Spend stay honestly 0.
  const noTokenEvents = (baseIso) => {
    const base = new Date(baseIso).getTime();
    return Array.from({ length: 12 }, (_, i) => ({
      kind: i % 2 === 0 ? 'user' : 'assistant', text: `msg ${i}`,
      ts: new Date(base + i * 2 * 60000).toISOString(),
    }));
  };
  replaceSession(
    { id: 'sSessE', project_id: proj3.id, source: 'cursor', file_path: '/tmp/sSessE.jsonl',
      started_at: '2026-08-05T13:00:00.000Z', ended_at: '2026-08-05T13:30:00.000Z',
      first_prompt: 'cursor prompt E' },
    noTokenEvents('2026-08-05T13:00:00.000Z'),
  );
});
after(() => teardown());

test('rollup=hourly, days=7 returns 168 hourly buckets — no silent daily coercion', () => {
  const r = explore.computeExplore({
    scope: { type: 'all' }, days: 7, metric: 'requests', group: 'source', rollup: 'hourly', topN: 10,
  });
  assert.equal(r.requestedRollup, 'hourly');
  assert.equal(r.rollup, 'hourly'); // must NOT be coarsened to 'daily'
  assert.equal(r.buckets?.length, 168);
});

// Step 4 ("Other" segment): the brief's e2e probe choice — the shared fixture
// generator (test/fixtures/gen-big-session.mjs) writes ONE cwd, and extending
// it to 6 tiny cwds purely to exercise >5-project folding is invasive for a
// generator every other e2e spec also depends on. Per the brief's documented
// implementer's choice ("implementer picks and documents"), this verifies the
// Other-series MATH at the engine (data-builder) level instead: with more
// group values than topN, the per-bucket sum across every returned series
// (topN + Other) must reconcile to that bucket's true unstacked total, within
// 1%. The client's chartData builder (src/ExploreTab.tsx) is a straight
// re-projection of `result.buckets` onto Recharts rows (one cell per ranked
// series, defaulting missing cells to 0) — it does not re-aggregate, so this
// server-side reconciliation is what actually proves "the stacked bar height
// equals the unstacked total" the brief asks for; the >5-project VISUAL
// check (a real screenshot with 6 distinct series rendered) is deferred to
// the C4 real-data walk, which has this repo's own multi-project session data
// to draw on instead of a synthetic fixture.
test('rollup Other segment: per-bucket series sum (topN + Other) reconciles to the bucket total, within 1%', () => {
  const r = explore.computeExplore({
    scope: { type: 'project', id: otherProjectId }, days: null, metric: 'requests', group: 'tool', rollup: 'daily', topN: 3,
  });
  assert.equal(r.buckets?.length, 2);
  const otherRow = r.rows.find((x) => x.key === 'Other');
  assert.ok(otherRow, 'expected an Other row — 5 distinct tools over 3 topN');
  assert.equal(otherRow.otherCount, 4); // Write, Edit, Glob, WebFetch

  const dayTotals = { '2026-08-01': 5 + 4 + 3 + 2 + 1, '2026-08-02': 2 + 6 + 3 + 1 };
  for (const bucket of r.buckets ?? []) {
    const seriesSum = Object.values(bucket.series).reduce((n, cell) => n + cell.requests, 0);
    const trueTotal = dayTotals[bucket.bucket];
    assert.ok(trueTotal != null, `unexpected bucket key ${bucket.bucket}`);
    const pctDiff = Math.abs(seriesSum - trueTotal) / trueTotal;
    assert.ok(pctDiff <= 0.01, `bucket ${bucket.bucket}: series sum ${seriesSum} vs true total ${trueTotal} (${(pctDiff * 100).toFixed(1)}% off)`);
  }
  // And the Other cell itself is genuinely non-zero in BOTH buckets (not a
  // bug that only zeroes out the overflow on one side).
  const day1Other = r.buckets?.find((b) => b.bucket === '2026-08-01')?.series.Other?.requests ?? 0;
  const day2Other = r.buckets?.find((b) => b.bucket === '2026-08-02')?.series.Other?.requests ?? 0;
  assert.equal(day1Other, 3 + 2); // Write + Edit
  assert.equal(day2Other, 3 + 1); // Glob + WebFetch
});

// ---- group=session (Task 16, spec §2.4) ----

// group=session, metric=spend: fixture sessions ranked by token cost
// (sessions.usage-sourced — EXACT_USAGE_GROUPS), each keyed by its session id
// (for row-click navigation) and labeled with its resolved display name.
test('computeExplore: group=session, metric=spend ranks fixture sessions by token cost, with resolved names', () => {
  const r = explore.computeExplore({
    scope: { type: 'all' }, days: null, metric: 'spend', group: 'session', rollup: 'total', topN: 10,
  });
  const sessRows = ['sSessA', 'sSessB', 'sSessC'].map((id) => r.rows.find((x) => x.key === id));
  assert.ok(sessRows.every(Boolean), 'expected all three fixture sessions as rows keyed by session id');
  const [a, b, c] = sessRows;

  // Server-side ranking proxy for spend/tokens is total tokens (see explore.ts
  // `mag`) — the client re-sorts by its own priced Spend, but ranking by
  // tokens is equivalent here since all three fixture sessions bill the same
  // model. sA (1500) > sB (300) > sC (100).
  const tokensOf = (row) => Object.values(row.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  assert.equal(tokensOf(a), 1500);
  assert.equal(tokensOf(b), 300);
  assert.equal(tokensOf(c), 100);
  const rankIdx = (id) => r.rows.findIndex((x) => x.key === id);
  assert.ok(rankIdx('sSessA') < rankIdx('sSessB'), 'sSessA (1500 tokens) should rank above sSessB (300)');
  assert.ok(rankIdx('sSessB') < rankIdx('sSessC'), 'sSessB (300 tokens) should rank above sSessC (100)');

  // Names resolve through the full name → summary → first_prompt fallback
  // chain (server/activity.ts displayName), not the raw session id.
  assert.equal(a.label, 'Renamed Session A');       // name wins over summary/first_prompt
  assert.equal(b.label, 'Auto Summary B');           // no name -> summary wins over first_prompt
  assert.equal(c.label, 'first prompt C (no name, no summary)'); // no name/summary -> first_prompt
});

// session is an EXACT_USAGE_GROUPS member — tokens come straight from that
// session's own sessions.usage row, so the result is never marked calibrated.
test('computeExplore: group=session tokens are exact (not calibrated)', () => {
  const r = explore.computeExplore({
    scope: { type: 'all' }, days: null, metric: 'tokens', group: 'session', rollup: 'total', topN: 10,
  });
  assert.equal(r.calibrated, false);
});

// Code-review fix: a session whose SOURCE never writes sessions.usage
// (codex/cursor/opencode) must not silently show Tokens=0 next to a real
// nonzero Requests count. sSessD (codex-like: no usage, but real per-message
// input_tokens/output_tokens) falls back to those per-message cells —
// 6 assistant turns x (10 in, 5 out) = 60/30, matching rhythmEvents' fixture.
test('computeExplore: group=session falls back to per-message tokens when sessions.usage is absent (codex-like)', () => {
  const r = explore.computeExplore({
    scope: { type: 'all' }, days: null, metric: 'spend', group: 'session', rollup: 'total', topN: 10,
  });
  const d = r.rows.find((x) => x.key === 'sSessD');
  assert.ok(d, 'expected sSessD as a row');
  assert.ok(d.requests > 0, 'sanity: sSessD has real requests');
  const tokens = Object.values(d.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  assert.equal(tokens, 90); // 6 x (10+5) — real per-message data, NOT silently zeroed
  assert.ok(d.tokensByModel['gpt-5-codex'], 'expected the fallback to preserve the real per-message model key');
});

// sSessE (cursor/opencode-like: no usage AND no per-message token fields at
// all) has nothing to fall back to — Tokens/Spend stay honestly 0 rather than
// fabricating a number, while Requests still reflects the real message count.
test('computeExplore: group=session stays honestly 0 tokens when a source has no token telemetry at all (cursor/opencode-like)', () => {
  const r = explore.computeExplore({
    scope: { type: 'all' }, days: null, metric: 'spend', group: 'session', rollup: 'total', topN: 10,
  });
  const e = r.rows.find((x) => x.key === 'sSessE');
  assert.ok(e, 'expected sSessE as a row');
  assert.ok(e.requests > 0, 'sanity: sSessE has real requests');
  const tokens = Object.values(e.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  assert.equal(tokens, 0);
});

// scope={type:'project', id} still filters group=session to that project's
// own sessions (the same scope+minorGate every other group honors).
test('computeExplore: group=session respects scope=project', () => {
  const proj3Id = dbModule.db.prepare("SELECT project_id FROM sessions WHERE id = 'sSessA'").get().project_id;
  const r = explore.computeExplore({
    scope: { type: 'project', id: proj3Id }, days: null, metric: 'spend', group: 'session', rollup: 'total', topN: 10,
  });
  // proj3 now also holds sSessD (codex) and sSessE (cursor) — the code-review
  // fallback fixtures — so 5 sessions, not 3.
  assert.equal(r.rows.length, 5);
  assert.ok(r.rows.every((x) => ['sSessA', 'sSessB', 'sSessC', 'sSessD', 'sSessE'].includes(x.key)));
});
