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
// minimal (a couple of messages). Cross-session aggregation tests need real
// sessions to clear the noise gate (agent_active_ms >= 5min AND
// message_count >= 10, server/noiseGate.ts DEFAULT_MINOR_*), so those get
// inert filler messages appended (no token fields — session totals come from
// `usage`, not summed message tokens, so filler cannot perturb the
// token-share arithmetic; it only pads message_count/active_ms). Three
// projects: p1 (the per-characteristic fixtures), p3 (sWorkflowA/B, isolated
// so the workflowRuns/subagentTurns aggregation math is exact), p2 (the
// missing-data regression fixtures, likewise isolated) — see the two
// code-review-fix blocks below for what each of p2/p3's sessions proves.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, content;
let p1Id, p2Id, p3Id; // project ids, set in before() — referenced by project-scoped tests below

const T0 = Date.parse('2026-08-05T00:00:00.000Z');
const iso = (offsetMs) => new Date(T0 + offsetMs).toISOString();

// `pairs` inert filler messages (user/assistant pairs, 60s apart) starting
// `startOffset` ms after T0 — pads message_count/active_ms to clear the
// noise gate (>=10 messages, >=5min active) without adding any
// token/context/sidechain signal. Returns the events and the offset
// immediately after the last filler message (for chaining). Default 6 pairs
// (12 messages, 6min active) gives a safety margin over the exact 10-message/
// 5-minute thresholds rather than landing exactly on the boundary.
function filler(startOffset, pairs = 6) {
  const events = [];
  let off = startOffset;
  for (let i = 0; i < pairs; i++) {
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
  p1Id = p1.id;

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
  //
  // Code-review fix regression coverage: ONE workflow turn (i===1) and ONE
  // direct turn (i===0) attach their tokens to a `kind:'tool_use'` row
  // instead of `kind:'assistant'` — mirroring how the REAL parser attaches
  // per-message usage to the FIRST event of an assistant API line, which is
  // the tool_use event itself when a turn is a bare tool call with no
  // preceding text (the common real-world subagent shape). Token AMOUNTS are
  // unchanged (still 150/turn, 120/turn), only which kind row carries them —
  // so the totals (450/240/690) and every assertion below are unchanged from
  // before the fix, but this fixture would have undercounted them under the
  // pre-fix `kind='assistant'`-only filter (RED against the old code).
  //
  // sWorkflowA/B live in their OWN project (p3, not p1) so the cross-session
  // aggregation test below can use `{type:'project', id:p3.id}` scope and
  // know EXACTLY which sessions' tokens are in the denominator — p1 already
  // hosts several other fixture sessions (s8h, sHighCtxAbs, ...) whose
  // tokens would otherwise dilute the hand-computed 45%/69%/46%/66% shares.
  const p3 = upsertProject('/tmp/proj-workflow-agg');
  p3Id = p3.id;
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
      if (i === 1) {
        // Bare tool-call turn: tokens land on the tool_use row, no separate
        // assistant text row exists for this turn at all.
        wfEvents.push({ kind: 'tool_use', tool_name: 'Bash', tool_use_id: `wf_tool_${i}`, is_sidechain: 1, agent_type: 'general-purpose', workflow_id: 'wf_fixture01', input_tokens: 100, output_tokens: 50, ts: iso(off) });
      } else {
        wfEvents.push({ kind: 'assistant', model: 'claude-sonnet-5', is_sidechain: 1, agent_type: 'general-purpose', workflow_id: 'wf_fixture01', input_tokens: 100, output_tokens: 50, ts: iso(off) });
      }
    }
    for (let i = 0; i < 2; i++) {
      off += 10_000;
      wfEvents.push({ kind: 'user', text: `direct subtask ${i}`, ts: iso(off), is_sidechain: 1, agent_type: 'Explore' });
      off += 10_000;
      if (i === 0) {
        wfEvents.push({ kind: 'tool_use', tool_name: 'Grep', tool_use_id: `direct_tool_${i}`, is_sidechain: 1, agent_type: 'Explore', input_tokens: 80, output_tokens: 40, ts: iso(off) });
      } else {
        wfEvents.push({ kind: 'assistant', model: 'claude-sonnet-5', is_sidechain: 1, agent_type: 'Explore', input_tokens: 80, output_tokens: 40, ts: iso(off) });
      }
    }
    const { events: fillerEvents } = filler(off);
    replaceSession(
      {
        id: 'sWorkflowA', project_id: p3.id, source: 'claude-code', file_path: '/tmp/sWorkflowA.jsonl',
        started_at: iso(0), ended_at: iso(off),
        usage: JSON.stringify({ 'claude-sonnet-5': { input: 700, output: 300, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
      },
      [...wfEvents, ...fillerEvents],
    );
  }

  // ── sWorkflowB: 1 workflow-tagged turn (workflow_id 'wf_fixture02', 100
  // tokens) only, and this session's ONLY sidechain row is a BARE
  // `kind:'tool_use'` turn (no `kind:'assistant'` row at all for this
  // workflow) — the exact shape the code review's reviewer reproduced
  // (subagentTurns/workflowRuns reading {share:0,count:0} pre-fix even
  // though real tokens were spent). session usage = 200 exactly ->
  // workflowRuns = subagentTurns = 100/200 = 50% (no direct subagent turns
  // here, so the two numerators are identical for this session). Also
  // proves workflowRuns' distinct workflow-id COUNT aggregates across
  // sessions (wf_fixture01 + wf_fixture02 = 2) and that per-session token
  // shares correctly dilute at project scope.
  {
    const wfEvents = [
      { kind: 'user', text: 'kick off workflow 2', ts: iso(0) },
      { kind: 'assistant', model: 'claude-sonnet-5', text: 'starting wf_fixture02', ts: iso(10_000) },
      { kind: 'user', text: 'wf2 subtask', ts: iso(20_000), is_sidechain: 1, agent_type: 'general-purpose', workflow_id: 'wf_fixture02' },
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'wf2_tool', is_sidechain: 1, agent_type: 'general-purpose', workflow_id: 'wf_fixture02', input_tokens: 70, output_tokens: 30, ts: iso(30_000) },
    ];
    const { events: fillerEvents } = filler(30_000);
    replaceSession(
      {
        id: 'sWorkflowB', project_id: p3.id, source: 'claude-code', file_path: '/tmp/sWorkflowB.jsonl',
        started_at: iso(0), ended_at: iso(30_000),
        usage: JSON.stringify({ 'claude-sonnet-5': { input: 150, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
      },
      [...wfEvents, ...fillerEvents],
    );
  }

  // ── Missing-data project (p2): code-review fix (Important) — a session
  // missing the underlying column for a characteristic must be excluded
  // from BOTH that characteristic's numerator AND denominator, not silently
  // treated as "doesn't qualify" (which would deflate the share for every
  // OTHER session with no visible sign). Isolated into its own project so
  // `{type:'project', id:p2.id}` scope gives full arithmetic control,
  // untouched by p1's other fixture sessions.
  //
  //   sCtrlA   tok=1000  active>=8h (qualifies eightHourSessions)  no context_tokens
  //   sNoDurA  tok=3000  active/engaged NULLED post-hoc            no context_tokens
  //   sCtrlB   tok=1000  short active (non-null)  context_tokens=200,000 (1M window: qualifies highContextAbs only)
  //   sNoCtxB  tok=2000  short active (non-null)  context_tokens OMITTED (NULL)
  //
  // eightHour bucket: only sCtrlA/sCtrlB/sNoCtxB have non-null duration data
  // (sNoDurA excluded) -> denom = 1000+1000+2000 = 4000; numerator = 1000
  // (sCtrlA only) -> share = 1000/4000 = 25% exactly. Pre-fix (`?? 0`) math
  // would have used denom = ALL FOUR sessions' tokens (7000, treating
  // sNoDurA's null active as "0, doesn't qualify" but still countable) ->
  // 1000/7000 ≈ 14% — a different, wrong number this test catches.
  //
  // highContextAbs bucket: only sCtrlB has non-null context_tokens (sCtrlA/
  // sNoDurA/sNoCtxB all excluded) -> denom = 1000; numerator = 1000 (sCtrlB
  // qualifies, 200,000 > 150,000) -> share = 100% exactly. Pre-fix math would
  // have used denom = ALL FOUR (7000) -> 1000/7000 ≈ 14%.
  const p2 = upsertProject('/tmp/proj-missing-data');
  p2Id = p2.id;

  {
    // sCtrlA: same "matched tool_result" 9h-active trick as s8h, padded with
    // filler (message count + a comfortable active-time margin) to clear the
    // noise gate at project scope (session scope, used elsewhere, bypasses
    // the gate — this is a fresh session precisely because it needs to
    // participate in project-scope aggregation).
    const events = [
      { kind: 'user', text: 'start the build', ts: iso(0) },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50, ts: iso(10_000) },
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'ctrl_a_longbuild', ts: iso(20_000) },
      { kind: 'tool_result', tool_use_id: 'ctrl_a_longbuild', text: 'build finished', ts: iso(20_000 + 9 * 3600_000) },
    ];
    const { events: fillerEvents, endOffset } = filler(20_000 + 9 * 3600_000);
    replaceSession(
      {
        id: 'sCtrlA', project_id: p2.id, source: 'claude-code', file_path: '/tmp/sCtrlA.jsonl',
        started_at: iso(0), ended_at: iso(endOffset),
        usage: JSON.stringify({ 'claude-sonnet-5': { input: 700, output: 300, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
      },
      [...events, ...fillerEvents],
    );
  }

  {
    // sNoDurA: padded with filler BEFORE the post-hoc NULL-out, so it clears
    // the noise gate at insert time (minor is computed from the real
    // agent_active_ms at that moment) — the raw UPDATE afterward only blanks
    // the two columns computeSessionCharStats reads, simulating a legacy
    // pre-migration row, not an actual noise-gate-eligible session.
    const { events: fillerEvents, endOffset } = filler(0);
    replaceSession(
      {
        id: 'sNoDurA', project_id: p2.id, source: 'claude-code', file_path: '/tmp/sNoDurA.jsonl',
        started_at: iso(0), ended_at: iso(endOffset),
        usage: JSON.stringify({ 'claude-sonnet-5': { input: 2100, output: 900, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
      },
      fillerEvents,
    );
    dbModule.db.prepare('UPDATE sessions SET agent_active_ms = NULL, engaged_ms = NULL WHERE id = ?').run('sNoDurA');
  }

  {
    // sCtrlB: context_tokens=200,000 with the 1M-window model (qualifies
    // highContextAbs only, same logic as sHighCtxAbs above) but SHORT active
    // time (filler only, ~6min) so it does NOT qualify eightHourSessions —
    // it still has non-null duration data, so it counts in the eightHour
    // DENOMINATOR without counting in that numerator.
    const { events: fillerEvents, endOffset } = filler(0);
    replaceSession(
      {
        id: 'sCtrlB', project_id: p2.id, source: 'claude-code', file_path: '/tmp/sCtrlB.jsonl',
        started_at: iso(0), ended_at: iso(endOffset), context_tokens: 200_000,
        usage: JSON.stringify({ 'claude-sonnet-5': { input: 700, output: 300, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
      },
      fillerEvents,
    );
  }

  {
    // sNoCtxB: context_tokens deliberately omitted (NULL, not 0) — mirrors a
    // non-claude-code source or a pre-context-tracking import.
    const { events: fillerEvents, endOffset } = filler(0);
    replaceSession(
      {
        id: 'sNoCtxB', project_id: p2.id, source: 'codex', file_path: '/tmp/sNoCtxB.jsonl',
        started_at: iso(0), ended_at: iso(endOffset),
        usage: JSON.stringify({ 'claude-sonnet-5': { input: 1400, output: 600, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
      },
      fillerEvents,
    );
  }
});
after(() => teardown());

// D4 (feedback-round Task 12): at all/project scope, `.share` was renamed to
// the generic `.value` (Characteristic now also carries label/why/info/format
// so the client can render without switching on `key` — see server/content.ts).
// At session scope, the four threshold predicates that always collapsed to a
// meaningless 0%/100% at N=1 (eightHourSessions/highContextAbs/highContextRel/
// autonomousShare) are REPLACED by absolute session facts
// (marathonBadge/peakContextTokens/unattendedRatio); cacheEfficiency/
// subagentTurns/workflowRuns carry over unchanged (real percentages even for
// one session).
describe('computeContent().characteristics — contract', () => {
  test('all/project scope: result carries exactly the 7 keys from spec §2.5, in order (highContextRel + subagentTurns lead, the old narrative callouts\' framing)', () => {
    const r = content.computeContent({ type: 'project', id: p1Id }, null);
    assert.equal(r.characteristicsScope, 'project');
    assert.deepEqual(r.characteristics.map((c) => c.key), [
      'highContextRel', 'subagentTurns', 'eightHourSessions',
      'workflowRuns', 'highContextAbs', 'cacheEfficiency', 'autonomousShare',
    ]);
  });

  test('session scope: characteristicsScope is "session" and the four threshold predicates are gone', () => {
    const r = content.computeContent({ type: 'session', id: 's8h' }, null);
    assert.equal(r.characteristicsScope, 'session');
    const keys = r.characteristics.map((c) => c.key);
    for (const dropped of ['eightHourSessions', 'highContextAbs', 'highContextRel', 'autonomousShare']) {
      assert.ok(!keys.includes(dropped), `session scope should not carry ${dropped}`);
    }
  });

  test('every characteristic is exact:true (all numerators are session-level or exact sidechain columns, never text-length calibration)', () => {
    const r = content.computeContent({ type: 'session', id: 's8h' }, null);
    for (const c of r.characteristics) assert.equal(c.exact, true, `${c.key} should be exact`);
  });
});

describe('session-scope marathonBadge + unattendedRatio (s8h)', () => {
  test('s8h (9h matched-tool-result gap): marathonBadge crosses 8h (~9.0h, warn), unattendedRatio ≈17% (well under 25%, warn)', () => {
    const r = content.computeContent({ type: 'session', id: 's8h' }, null);
    const marathon = findChar(r, 'marathonBadge');
    assert.equal(marathon.value, 9);
    assert.equal(marathon.count, 1);
    assert.equal(marathon.warn, true);
    const unattended = findChar(r, 'unattendedRatio');
    assert.equal(unattended.value, 17); // 5,420,000 / 32,420,000 ≈ 16.7% -> rounds to 17
    assert.equal(unattended.warn, true);
  });

  test('s8h has zero workflow/subagent/cache facts and no peakContextTokens fact (no context_tokens stored)', () => {
    const r = content.computeContent({ type: 'session', id: 's8h' }, null);
    for (const key of ['workflowRuns', 'subagentTurns', 'cacheEfficiency']) {
      const c = findChar(r, key);
      assert.equal(c.value, 0, `${key} value should be 0`);
    }
    assert.equal(r.characteristics.some((c) => c.key === 'peakContextTokens'), false);
  });
});

describe('session-scope peakContextTokens folds the old abs/rel pair into one fact (sHighCtxAbs / sHighCtxRel)', () => {
  test('sHighCtxAbs (200k ctx, 1M window): value=200000 tokens, value2=20% of window (well under the 70% warn line)', () => {
    const r = content.computeContent({ type: 'session', id: 'sHighCtxAbs' }, null);
    const c = findChar(r, 'peakContextTokens');
    assert.equal(c.value, 200_000);
    assert.equal(c.value2, 20);
    assert.equal(c.warn, false);
  });

  test('sHighCtxRel (145k ctx, 200k window): value=145000 tokens, value2=73% of window (past the 70% warn line)', () => {
    const r = content.computeContent({ type: 'session', id: 'sHighCtxRel' }, null);
    const c = findChar(r, 'peakContextTokens');
    assert.equal(c.value, 145_000);
    assert.equal(c.value2, 73);
    assert.equal(c.warn, true);
  });
});

describe('session-scope cacheEfficiency (sCache)', () => {
  test('cacheRead 9000 / (cacheRead 9000 + input 1000) = exactly 90%', () => {
    const r = content.computeContent({ type: 'session', id: 'sCache' }, null);
    const c = findChar(r, 'cacheEfficiency');
    assert.equal(c.value, 90);
  });
});

describe('workflowRuns + subagentTurns — session scope (sWorkflowA)', () => {
  test('workflowRuns: 450 wf_fixture01 tokens / 1000 session total = 45%, count = 1 distinct workflow', () => {
    const r = content.computeContent({ type: 'session', id: 'sWorkflowA' }, null);
    const c = findChar(r, 'workflowRuns');
    assert.equal(c.value, 45);
    assert.equal(c.count, 1);
  });

  test('subagentTurns: (450 workflow + 240 direct) = 690 / 1000 session total = 69%, count = 5 turns', () => {
    const r = content.computeContent({ type: 'session', id: 'sWorkflowA' }, null);
    const c = findChar(r, 'subagentTurns');
    assert.equal(c.value, 69);
    assert.equal(c.count, 5);
  });
});

// CRITICAL code-review fix regression: sWorkflowB's ONLY sidechain row is a
// bare tool_use turn (no kind:'assistant' row exists in this session at
// all). Pre-fix (`m.kind='assistant'` filter), this session's real 100
// tokens of subagent spend were invisible: both workflowRuns and
// subagentTurns read {value:0, count:0} even though wf_fixture02 genuinely
// ran and spent tokens — exactly what the reviewer reproduced. Post-fix
// (`m.kind IN ('assistant','tool_use')`), both read their true share.
describe('workflowRuns + subagentTurns — bare tool_use turn, no assistant row at all (sWorkflowB)', () => {
  test('workflowRuns: 100 wf_fixture02 tokens (on a tool_use row) / 200 session total = 50%, count = 1', () => {
    const r = content.computeContent({ type: 'session', id: 'sWorkflowB' }, null);
    const c = findChar(r, 'workflowRuns');
    assert.equal(c.value, 50);
    assert.equal(c.count, 1);
  });

  test('subagentTurns: same 100 tokens (no direct turns in this session) / 200 session total = 50%, count = 1', () => {
    const r = content.computeContent({ type: 'session', id: 'sWorkflowB' }, null);
    const c = findChar(r, 'subagentTurns');
    assert.equal(c.value, 50);
    assert.equal(c.count, 1);
  });
});

describe('workflowRuns + subagentTurns — cross-session aggregation (scope=project p3, sWorkflowA + sWorkflowB)', () => {
  test('workflowRuns counts BOTH wf_fixture01 and wf_fixture02 as distinct runs (one of them tool_use-only) and dilutes the share across both sessions\' totals', () => {
    const r = content.computeContent({ type: 'project', id: p3Id }, null);
    const c = findChar(r, 'workflowRuns');
    // Σ workflow tokens = 450 (A) + 100 (B) = 550; Σ session totals = 1000 (A) + 200 (B) = 1200.
    const expectedShare = Math.round((450 + 100) / (1000 + 200) * 100); // 46
    assert.equal(c.value, expectedShare);
    assert.equal(c.count, 2); // distinct workflow_id: wf_fixture01, wf_fixture02
  });

  test('subagentTurns aggregates ALL sidechain turns (workflow + direct, assistant AND tool_use kind) across both sessions', () => {
    const r = content.computeContent({ type: 'project', id: p3Id }, null);
    const c = findChar(r, 'subagentTurns');
    // Σ sidechain tokens = 690 (A: 450 wf + 240 direct) + 100 (B) = 790; Σ totals = 1200.
    const expectedShare = Math.round((690 + 100) / (1000 + 200) * 100); // 66
    assert.equal(c.value, expectedShare);
    assert.equal(c.count, 6); // 3 wf + 2 direct (A) + 1 wf (B)
  });
});

// IMPORTANT code-review fix regression: a session with NULL agent_active_ms/
// engaged_ms (sNoDurA) or NULL context_tokens (sNoCtxB) must be excluded from
// BOTH the numerator AND the denominator of the affected characteristic(s) —
// not counted in the denominator while silently reading 0 in the numerator
// (which would deflate every OTHER session's share with no visible sign).
// These are all-scope/project-scope assertions (allProjectShares), so the
// eightHourSessions/highContextAbs/highContextRel keys are still in play here
// (only session scope replaces them with absolute facts).
describe('missing-data exclusion (scope=project p2): eightHourSessions/highContextAbs exclude sessions without the underlying column from BOTH sides of the share', () => {
  test('eightHourSessions: denom excludes sNoDurA (null active/engaged) — 1000 (sCtrlA, qualifies) / 4000 (sCtrlA+sCtrlB+sNoCtxB, all have real duration data) = 25%, count = 1', () => {
    const r = content.computeContent({ type: 'project', id: p2Id }, null);
    const c = findChar(r, 'eightHourSessions');
    assert.equal(c.value, 25);
    assert.equal(c.count, 1);
  });

  test('highContextAbs: denom excludes sCtrlA/sNoDurA/sNoCtxB (no context_tokens) — 1000 (sCtrlB, qualifies) / 1000 (sCtrlB, the only session WITH context data) = 100%, count = 1', () => {
    const r = content.computeContent({ type: 'project', id: p2Id }, null);
    const c = findChar(r, 'highContextAbs');
    assert.equal(c.value, 100);
    assert.equal(c.count, 1);
  });

  test('highContextRel: same denom as highContextAbs (only sCtrlB has context data) — sCtrlB does not clear the relative threshold, so value = 0%, count = 0 (not 0/7000 from an inflated denom, and not skipped/undefined)', () => {
    const r = content.computeContent({ type: 'project', id: p2Id }, null);
    const c = findChar(r, 'highContextRel');
    assert.equal(c.value, 0);
    assert.equal(c.count, 0);
  });
});
