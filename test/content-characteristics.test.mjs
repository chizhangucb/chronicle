// RED→GREEN unit tests for the Content tab's 7 usage characteristics (spec
// §2.5, task C3-T15). Each characteristic is exercised on a hand-built
// session whose `agent_active_ms`/`engaged_ms` (computed by replaceSession
// from the event timestamps via server/durations.ts) and `sessions.usage`
// (set directly, independent of per-message token fields — the authoritative
// billed total, same convention test/content.test.mjs already uses) are
// engineered so the qualifying/non-qualifying math can be verified by hand.
//
// Session-scope tests bypass the minor-session gate (server/scope.ts
// minorGate returns '' for a directly-opened session), so those fixtures stay
// minimal (a couple of messages). The one 'all'-scope aggregation test needs
// its sessions to clear the noise gate (agent_active_ms >= 5min AND
// message_count >= 10, server/noiseGate.ts DEFAULT_MINOR_*), so those two
// sessions get inert filler messages appended (no token fields — session
// totals come from `usage`, not summed message tokens, so filler cannot
// perturb the token-share arithmetic; it only pads message_count/active_ms).
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, content;

const T0 = Date.parse('2026-08-05T00:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

// 10 inert filler messages (5 user/assistant pairs, 60s apart) starting
// `startOffset` ms after T0 — pads message_count to clear the noise gate
// without adding any token/context/sidechain signal. Returns the events and
// the offset immediately after the last filler message (for chaining).
function filler(startOffset) {
  const events = [];
  let off = startOffset;
  for (let i = 0; i < 5; i++) {
    off += 60_000;
    events.push({ kind: 'user', text: `filler prompt ${i}`, ts: iso(off) });
    off += 60_000;
    events.push({ kind: 'assistant', model: 'claude-sonnet-5', text: `filler reply ${i}`, ts: iso(off) });
  }
  return { events, endOffset: off };
}

function findChar(result, key) {
  const c = result.characteristics.find((x) => x.key === key);
  assert.ok(c, `characteristics missing key ${key}`);
  return c;
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  content = await import('../server/content.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p1 = upsertProject('/tmp/proj-characteristics');

  // ── s8h: a 9-hour marathon session, built from ONE long-running tool call.
  // agentActiveMs's rule "gap ending in a tool_result matched to a prior
  // tool_use counted in FULL, no cap" (server/durations.ts) means a single
  // 9h gap between a tool_use and its tool_result adds the FULL 9h to
  // agent_active_ms, uncapped — hand-computed:
  //   row1 (assistant, gap 10s from row0's user)      -> active += 10s
  //   row2 (tool_use,  gap 10s from row1)              -> active += 10s
  //   row3 (tool_result, gap 9h from row2, MATCHED)    -> active += 9h (full)
  //   => agent_active_ms = 9h + 20s >= EIGHT_HOUR_ACTIVE_MS (8h). ✓
  // engagedMs has no human/matched exemption — every gap is capped at 90min:
  //   10s + 10s + min(9h, 90min) = 90min20s
  //   => engaged_ms (~5420s) is well under 25% of active_ms (~32420s;
  //      5420/32420 ≈ 16.7% < AUTONOMOUS_ENGAGED_RATIO 0.25). ✓ autonomous too.
  // No context_tokens, no sidechain, no cacheRead set, so every OTHER
  // characteristic must read 0 for this session.
  replaceSession(
    {
      id: 's8h', project_id: p1.id, source: 'claude-code', file_path: '/tmp/s8h.jsonl',
      started_at: iso(0), ended_at: iso(9 * 3600_000 + 20_000),
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 5000, output: 2000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
    },
    [
      { kind: 'user', text: 'start the build', ts: iso(0) },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50, ts: iso(10_000) },
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'longbuild', ts: iso(20_000) },
      { kind: 'tool_result', tool_use_id: 'longbuild', text: 'build finished', ts: iso(20_000 + 9 * 3600_000) },
    ],
  );

  // ── sHighCtxAbs: context_tokens=200,000 with a 1M-window model
  // (claude-sonnet-5) — 200,000 > HIGH_CONTEXT_ABS_TOKENS (150,000) but NOT
  // > 70% of a 1,000,000 window (700,000), so this qualifies highContextAbs
  // ONLY, not highContextRel. Session usage = 5000 tokens (arbitrary; only
  // matters as "the whole session's tokens", since session scope makes this
  // session its own 100% denominator).
  replaceSession(
    {
      id: 'sHighCtxAbs', project_id: p1.id, source: 'claude-code', file_path: '/tmp/sHighCtxAbs.jsonl',
      started_at: iso(0), ended_at: iso(10_000), context_tokens: 200_000,
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 4000, output: 1000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
    },
    [
      { kind: 'user', text: 'hi', ts: iso(0) },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 4000, output_tokens: 1000, ts: iso(10_000) },
    ],
  );

  // ── sHighCtxRel: context_tokens=145,000 with a 200K-window model
  // (claude-sonnet-4-5, which does NOT prefix-match 'claude-sonnet-5' in
  // shared/contextWindows.ts, so it falls into the generic 'claude-sonnet'
  // 200K bucket) — 145,000 is NOT > 150,000 (highContextAbs) but IS > 70% of
  // 200,000 = 140,000 (highContextRel). Qualifies highContextRel ONLY.
  replaceSession(
    {
      id: 'sHighCtxRel', project_id: p1.id, source: 'claude-code', file_path: '/tmp/sHighCtxRel.jsonl',
      started_at: iso(0), ended_at: iso(10_000), context_tokens: 145_000,
      usage: JSON.stringify({ 'claude-sonnet-4-5': { input: 3000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
    },
    [
      { kind: 'user', text: 'hi', ts: iso(0) },
      { kind: 'assistant', model: 'claude-sonnet-4-5', input_tokens: 3000, output_tokens: 500, ts: iso(10_000) },
    ],
  );

  // ── sCache: cacheRead=9000, input=1000 -> cacheEfficiency = 9000/(9000+1000)
  // = 90% exactly. No context_tokens/sidechain/8h-gap, so every other
  // characteristic must read 0 for this session.
  replaceSession(
    {
      id: 'sCache', project_id: p1.id, source: 'claude-code', file_path: '/tmp/sCache.jsonl',
      started_at: iso(0), ended_at: iso(10_000),
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 9000 } }),
    },
    [
      { kind: 'user', text: 'hi', ts: iso(0) },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 1000, output_tokens: 500, ts: iso(10_000) },
    ],
  );

  // ── sWorkflowA: 3 workflow-tagged subagent turns (workflow_id
  // 'wf_fixture01', 150 tokens each = 450 exact) + 2 direct-subagent turns
  // (workflow_id null, 120 tokens each = 240 exact) = 690 total sidechain
  // tokens. session usage = 1000 exactly, chosen so shares land on whole
  // numbers: workflowRuns = 450/1000 = 45%; subagentTurns = 690/1000 = 69%.
  // Padded with filler to clear the noise gate for the 'all'-scope test below.
  {
    const wfEvents = [
      { kind: 'user', text: 'kick off workflow', ts: iso(0) },
      { kind: 'assistant', model: 'claude-sonnet-5', text: 'starting wf_fixture01', ts: iso(10_000) },
    ];
    let off = 10_000;
    for (let i = 0; i < 3; i++) {
      off += 10_000;
      wfEvents.push({ kind: 'user', text: `wf subtask ${i}`, ts: iso(off), is_sidechain: 1, agent_type: 'general-purpose', workflow_id: 'wf_fixture01' });
      off += 10_000;
      wfEvents.push({ kind: 'assistant', model: 'claude-sonnet-5', is_sidechain: 1, agent_type: 'general-purpose', workflow_id: 'wf_fixture01', input_tokens: 100, output_tokens: 50, ts: iso(off) });
    }
    for (let i = 0; i < 2; i++) {
      off += 10_000;
      wfEvents.push({ kind: 'user', text: `direct subtask ${i}`, ts: iso(off), is_sidechain: 1, agent_type: 'Explore' });
      off += 10_000;
      wfEvents.push({ kind: 'assistant', model: 'claude-sonnet-5', is_sidechain: 1, agent_type: 'Explore', input_tokens: 80, output_tokens: 40, ts: iso(off) });
    }
    const { events: fillerEvents } = filler(off);
    replaceSession(
      {
        id: 'sWorkflowA', project_id: p1.id, source: 'claude-code', file_path: '/tmp/sWorkflowA.jsonl',
        started_at: iso(0), ended_at: iso(off),
        usage: JSON.stringify({ 'claude-sonnet-5': { input: 700, output: 300, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
      },
      [...wfEvents, ...fillerEvents],
    );
  }

  // ── sWorkflowB: 1 workflow-tagged turn (workflow_id 'wf_fixture02', 100
  // tokens) only. session usage = 200 exactly -> workflowRuns = subagentTurns
  // = 100/200 = 50% (no direct subagent turns here, so the two numerators
  // are identical for this session). Exists to prove workflowRuns' distinct
  // workflow-id COUNT aggregates across sessions (wf_fixture01 + wf_fixture02
  // = 2) and that per-session token shares correctly dilute in 'all' scope.
  {
    const wfEvents = [
      { kind: 'user', text: 'kick off workflow 2', ts: iso(0) },
      { kind: 'assistant', model: 'claude-sonnet-5', text: 'starting wf_fixture02', ts: iso(10_000) },
      { kind: 'user', text: 'wf2 subtask', ts: iso(20_000), is_sidechain: 1, agent_type: 'general-purpose', workflow_id: 'wf_fixture02' },
      { kind: 'assistant', model: 'claude-sonnet-5', is_sidechain: 1, agent_type: 'general-purpose', workflow_id: 'wf_fixture02', input_tokens: 70, output_tokens: 30, ts: iso(30_000) },
    ];
    const { events: fillerEvents } = filler(30_000);
    replaceSession(
      {
        id: 'sWorkflowB', project_id: p1.id, source: 'claude-code', file_path: '/tmp/sWorkflowB.jsonl',
        started_at: iso(0), ended_at: iso(30_000),
        usage: JSON.stringify({ 'claude-sonnet-5': { input: 150, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
      },
      [...wfEvents, ...fillerEvents],
    );
  }
});
after(() => teardown());

describe('computeContent().characteristics — contract', () => {
  test('result carries exactly the 7 keys from spec §2.5, in order', () => {
    const r = content.computeContent({ type: 'session', id: 's8h' }, null);
    assert.deepEqual(r.characteristics.map((c) => c.key), [
      'eightHourSessions', 'workflowRuns', 'subagentTurns',
      'highContextAbs', 'highContextRel', 'cacheEfficiency', 'autonomousShare',
    ]);
  });

  test('every characteristic is exact:true (all numerators are session-level or exact sidechain columns, never text-length calibration)', () => {
    const r = content.computeContent({ type: 'session', id: 's8h' }, null);
    for (const c of r.characteristics) assert.equal(c.exact, true, `${c.key} should be exact`);
  });
});

describe('eightHourSessions + autonomousShare (s8h)', () => {
  test('s8h (9h matched-tool-result gap) is 100% eightHourSessions and 100% autonomousShare in its own session scope', () => {
    const r = content.computeContent({ type: 'session', id: 's8h' }, null);
    const eightHour = findChar(r, 'eightHourSessions');
    assert.equal(eightHour.share, 100);
    assert.equal(eightHour.count, 1);
    const autonomous = findChar(r, 'autonomousShare');
    assert.equal(autonomous.share, 100);
    assert.equal(autonomous.count, 1);
  });

  test('s8h has zero workflow/subagent/context/cache characteristics (none of those signals are present)', () => {
    const r = content.computeContent({ type: 'session', id: 's8h' }, null);
    for (const key of ['workflowRuns', 'subagentTurns', 'highContextAbs', 'highContextRel', 'cacheEfficiency']) {
      const c = findChar(r, key);
      assert.equal(c.share, 0, `${key} share should be 0`);
      assert.equal(c.count, 0, `${key} count should be 0`);
    }
  });
});

describe('highContextAbs vs highContextRel — absolute and relative thresholds diverge by design', () => {
  test('sHighCtxAbs (200k ctx, 1M window): qualifies highContextAbs only', () => {
    const r = content.computeContent({ type: 'session', id: 'sHighCtxAbs' }, null);
    assert.equal(findChar(r, 'highContextAbs').share, 100);
    assert.equal(findChar(r, 'highContextAbs').count, 1);
    assert.equal(findChar(r, 'highContextRel').share, 0);
    assert.equal(findChar(r, 'highContextRel').count, 0);
  });

  test('sHighCtxRel (145k ctx, 200k window): qualifies highContextRel only', () => {
    const r = content.computeContent({ type: 'session', id: 'sHighCtxRel' }, null);
    assert.equal(findChar(r, 'highContextRel').share, 100);
    assert.equal(findChar(r, 'highContextRel').count, 1);
    assert.equal(findChar(r, 'highContextAbs').share, 0);
    assert.equal(findChar(r, 'highContextAbs').count, 0);
  });
});

describe('cacheEfficiency (sCache)', () => {
  test('cacheRead 9000 / (cacheRead 9000 + input 1000) = exactly 90%', () => {
    const r = content.computeContent({ type: 'session', id: 'sCache' }, null);
    const c = findChar(r, 'cacheEfficiency');
    assert.equal(c.share, 90);
    assert.equal(c.count, 1);
  });
});

describe('workflowRuns + subagentTurns — session scope (sWorkflowA)', () => {
  test('workflowRuns: 450 wf_fixture01 tokens / 1000 session total = 45%, count = 1 distinct workflow', () => {
    const r = content.computeContent({ type: 'session', id: 'sWorkflowA' }, null);
    const c = findChar(r, 'workflowRuns');
    assert.equal(c.share, 45);
    assert.equal(c.count, 1);
  });

  test('subagentTurns: (450 workflow + 240 direct) = 690 / 1000 session total = 69%, count = 5 turns', () => {
    const r = content.computeContent({ type: 'session', id: 'sWorkflowA' }, null);
    const c = findChar(r, 'subagentTurns');
    assert.equal(c.share, 69);
    assert.equal(c.count, 5);
  });
});

describe('workflowRuns + subagentTurns — cross-session aggregation (scope=all, sWorkflowA + sWorkflowB)', () => {
  test('workflowRuns counts BOTH wf_fixture01 and wf_fixture02 as distinct runs and dilutes the share across both sessions\' totals', () => {
    const r = content.computeContent({ type: 'all' }, null);
    const c = findChar(r, 'workflowRuns');
    // Σ workflow tokens = 450 (A) + 100 (B) = 550; Σ session totals = 1000 (A) + 200 (B) = 1200.
    const expectedShare = Math.round((450 + 100) / (1000 + 200) * 100); // 46
    assert.equal(c.share, expectedShare);
    assert.equal(c.count, 2); // distinct workflow_id: wf_fixture01, wf_fixture02
  });

  test('subagentTurns aggregates ALL sidechain turns (workflow + direct) across both sessions', () => {
    const r = content.computeContent({ type: 'all' }, null);
    const c = findChar(r, 'subagentTurns');
    // Σ sidechain tokens = 690 (A: 450 wf + 240 direct) + 100 (B) = 790; Σ totals = 1200.
    const expectedShare = Math.round((690 + 100) / (1000 + 200) * 100); // 66
    assert.equal(c.share, expectedShare);
    assert.equal(c.count, 6); // 3 wf + 2 direct (A) + 1 wf (B)
  });
});
