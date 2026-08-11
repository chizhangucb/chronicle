import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, explore;

// Divergence from the brief's literal fixture code (same pattern as
// test/insights.test.mjs's documented divergence): the brief's `rhythmEvents`
// hardcodes model:'claude-sonnet-5' on every assistant message, but s2's
// `usage` JSON claims 'claude-haiku-4-5' and group-by-model is message-exact
// (per-message m.model, not the session usage aggregate) — so without a
// per-session model override, no message row would ever carry
// 'claude-haiku-4-5' and `r.rows.some(x => x.key === 'claude-haiku-4-5')`
// could never pass regardless of implementation. Added a `model` param
// (default 'claude-sonnet-5', unchanged for s1) so s2's fixture messages
// actually carry the model its usage aggregate claims.
function rhythmEvents(baseIso, extra = [], model = 'claude-sonnet-5') {
  const base = new Date(baseIso).getTime();
  const events = [];
  for (let i = 0; i < 12; i++) {
    events.push({
      kind: i % 2 === 0 ? 'user' : 'assistant',
      text: `msg ${i}`,
      ts: new Date(base + i * 2 * 60000).toISOString(),
      ...(i % 2 === 1 ? { model, input_tokens: 100, output_tokens: 50 } : {}),
    });
  }
  return [...events, ...extra];
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p1 = upsertProject('/tmp/proj-a');
  const p2 = upsertProject('/tmp/proj-b');
  // DIVERGENCE (the crux of the reconcile fix): s1's per-message sonnet tokens
  // are 6 assistant turns × (100 in, 50 out) = 600/300, PLUS a sidechain
  // assistant of 200/80 (→ 800/380 across all assistant kinds). The session's
  // `usage` JSON below deliberately claims DIFFERENT totals (1200 in / 700 out)
  // — the authoritative billed truth Overview/Insights reads. Every group=model
  // /project/source token assertion below expects the USAGE numbers, so a test
  // that read per-message columns instead would fail: the divergence is what
  // proves tokens come from sessions.usage, not the per-message sums.
  replaceSession(
    { id: 's1', project_id: p1.id, source: 'claude-code', file_path: '/tmp/s1.jsonl',
      started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1200, output: 700, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-01T10:00:00.000Z', [
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 't1', ts: '2026-08-01T10:24:00.000Z' },
      { kind: 'tool_result', tool_use_id: 't1', text: 'ok output text', ts: '2026-08-01T10:24:03.000Z' },
      { kind: 'assistant', model: 'claude-sonnet-5', is_sidechain: 1, agent_type: 'general-purpose',
        input_tokens: 200, output_tokens: 80, text: 'subagent work here', ts: '2026-08-01T10:25:00.000Z' },
      // Second Bash call that errors — for the errors-metric fix (Finding 1,
      // 5e-0 review round). Paired via tool_use_id 't2', same tool_name as
      // the ok one above, so the 'Bash' row must show errors===1 (only this
      // one), not 2 (double-counting the ok result) or the session's full
      // message count (the old cross-join bug).
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 't2', ts: '2026-08-01T10:26:00.000Z' },
      { kind: 'tool_result', tool_use_id: 't2', text: 'Error: boom', ts: '2026-08-01T10:26:03.000Z' },
      // Locks the tool_input calibration-char-source fix (5e-1 code review):
      // real tool_use rows carry their content in tool_input, NOT text (text
      // is null/absent here, matching production JSONL) — before the fix,
      // the calibrated char measure summed LENGTH(text) only, so this row
      // contributed 0 chars and its calibrated tokens came out 0 regardless
      // of scope/date range. Paired with a NON-erroring tool_result so this
      // doesn't perturb the errors-by-source/tool assertions elsewhere.
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 't3',
        tool_input: JSON.stringify({ cmd: 'ls -la /some/long/path' }), ts: '2026-08-01T10:27:00.000Z' },
      { kind: 'tool_result', tool_use_id: 't3', text: 'read ok', ts: '2026-08-01T10:27:03.000Z' },
    ]),
  );
  replaceSession(
    { id: 's2', project_id: p2.id, source: 'codex', file_path: '/tmp/s2.jsonl',
      started_at: '2026-08-02T03:00:00.000Z', ended_at: '2026-08-02T03:30:00.000Z',
      usage: JSON.stringify({ 'claude-haiku-4-5': { input: 40, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-02T03:00:00.000Z', [], 'claude-haiku-4-5'),
  );
  // sDup has ONE erroring tool_result (te1) but TWO tool_use rows sharing
  // tool_use_id 'te1' — the pairing join must attribute exactly ONE error.
  replaceSession(
    { id: 'sDup', project_id: p1.id, source: 'claude-code', file_path: '/tmp/sDup.jsonl',
      started_at: '2026-08-03T10:00:00.000Z', ended_at: '2026-08-03T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 500, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    rhythmEvents('2026-08-03T10:00:00.000Z', [
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'te1', ts: '2026-08-03T10:24:00.000Z' },
      // DUPLICATE tool_use for the same id (mirrors a real re-imported/duped row).
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'te1', ts: '2026-08-03T10:24:01.000Z' },
      { kind: 'tool_result', tool_use_id: 'te1', text: 'Error: boom', ts: '2026-08-03T10:24:03.000Z' },
    ]),
  );
});
after(() => teardown());

// Token MAGNITUDE for group=model comes from sessions.usage (the authoritative
// billed total = Overview/Insights), NOT the per-message token columns. The
// fixture diverges the two (usage sonnet 1200/700 vs per-message 800/380;
// usage haiku 40/20 vs per-message 600/300) so this assertion can only pass if
// tokens are sourced from usage. sDup (added for the 6-0.2 dedup fixture) also
// declares sonnet usage 500/200, so the sonnet totals below include it: 1700/900.
test('computeExplore: group by model tokens come from sessions.usage, not per-message', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'model', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, false);
  const sonnet = r.rows.find((x) => x.key === 'claude-sonnet-5');
  assert.ok(sonnet);
  assert.equal(sonnet.tokensByModel['claude-sonnet-5'].input, 1700);  // usage (1200 s1 + 500 sDup), not 800 per-message
  assert.equal(sonnet.tokensByModel['claude-sonnet-5'].output, 900);  // usage (700 s1 + 200 sDup), not 380 per-message
  const haiku = r.rows.find((x) => x.key === 'claude-haiku-4-5');
  assert.ok(haiku);
  assert.equal(haiku.tokensByModel['claude-haiku-4-5'].input, 40);    // usage, not 600 per-message
  assert.equal(haiku.tokensByModel['claude-haiku-4-5'].output, 20);   // usage, not 300 per-message
});

// group=project token totals reconcile to Σ that project's sessions.usage.
// sDup is also project p1 (proj-a), so proj-a includes its 700 (500+200).
test('computeExplore: group by project token total reconciles to Σ sessions.usage', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'project', rollup: 'total', topN: 10 });
  const sum = (row) => Object.values(row.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  const a = r.rows.find((x) => x.key === 'proj-a');
  const b = r.rows.find((x) => x.key === 'proj-b');
  assert.ok(a && b);
  assert.equal(sum(a), 2600); // s1 usage 1200+700, plus sDup usage 500+200
  assert.equal(sum(b), 60);   // s2 usage 40+20
});

// group=source token totals reconcile to Σ that source's sessions.usage.
// sDup is also source 'claude-code', so cc includes its 700 (500+200).
test('computeExplore: group by source token total reconciles to Σ sessions.usage', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'source', rollup: 'total', topN: 10 });
  const sum = (row) => Object.values(row.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  const cc = r.rows.find((x) => x.key === 'claude-code');
  const cx = r.rows.find((x) => x.key === 'codex');
  assert.ok(cc && cx);
  assert.equal(sum(cc), 2600);
  assert.equal(sum(cx), 60);
});

// Whole-scope reconciliation: Σ over rows Σ tokensByModel(input+output) for
// group=model equals Σ all sessions.usage(input+output) in scope (2660,
// including sDup's 700).
test('computeExplore: group=model total tokens reconcile to Σ sessions.usage across the scope', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'model', rollup: 'total', topN: 10 });
  const total = r.rows.reduce((n, row) => n + Object.values(row.tokensByModel).reduce((m, u) => m + u.input + u.output, 0), 0);
  assert.equal(total, 2660); // (1200+700) + (40+20) + sDup (500+200)
});

test('computeExplore: scope=project filters to one project', () => {
  const r = explore.computeExplore({ scope: { type: 'project', id: 1 }, days: null, metric: 'requests', group: 'source', rollup: 'total', topN: 10 });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].key, 'claude-code');
});

test('computeExplore: group by subagent is EXACT (sidechain agent_type + per-message tokens)', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'subagent', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, false);
  const gp = r.rows.find((x) => x.key === 'general-purpose');
  assert.ok(gp);
  assert.equal(gp.tokensByModel['claude-sonnet-5'].input, 200);
});

test('computeExplore: group by tool is CALIBRATED', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'tool', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, true);
  assert.ok(r.rows.some((x) => x.key === 'Bash'));
});

// Subgroup segments stay PER-MESSAGE (documented): they subdivide the bar
// proportionally on the client (normalized by their own sum), so they need not
// equal the usage-based row total. Here the sonnet row's usage total (2600,
// incl. sDup's 700) deliberately DIVERGES from the per-message segment sum
// (2080 = 1180 from s1 [6×150 main + 280 sidechain] + 900 from sDup's 6×150
// assistant turns, all assistant kinds), which proves segments are per-message
// while the row magnitude is usage-sourced.
test('computeExplore: subgroup segments are per-message (subdivide the usage bar proportionally)', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'model', subgroup: 'project', rollup: 'total', topN: 10 });
  const sonnet = r.rows.find((x) => x.key === 'claude-sonnet-5');
  const segSum = sonnet.segments.reduce((n, s) => n + s.tokens, 0);
  const rowTokens = Object.values(sonnet.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  assert.equal(segSum, 2080);      // per-message sonnet assistant tokens (incl. sidechain, incl. sDup)
  assert.equal(rowTokens, 2600);   // usage-based row total — intentionally different
});

test('computeExplore: topN caps rows and folds the rest into an "Other" row', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'requests', group: 'model', rollup: 'total', topN: 1 });
  assert.ok(r.rows.length <= 2);
  assert.ok(r.rows.some((x) => x.key === 'Other') || r.rows.length === 1);
});

// Locks Finding 1 (5e-0 review): errors must be counted ONCE per erroring
// tool_result, attributed via tool_use_id pairing — not cross-joined against
// every tool_result co-resident in the session. Two erroring Bash results in
// scope: s1's t2 and sDup's te1 (te1's duplicated tool_use pairs to exactly
// one result via MIN(id), so it still contributes exactly 1, not 2).
test('computeExplore: errors for group=tool count only the erroring tool_result, not the ok one', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'errors', group: 'tool', rollup: 'total', topN: 10 });
  const bash = r.rows.find((x) => x.key === 'Bash');
  assert.ok(bash);
  assert.equal(bash.errors, 2);
});

// Locks the multiplicative-over-count regression specifically: for
// group=source, g.where is '' so `m`/`r` range over every message kind in
// the session — the old cross-join counted errors once per co-resident
// message (17 in this fixture's s1), not once per erroring tool_result.
// Two erroring results in scope for source='claude-code': s1's t2 + sDup's te1.
test('computeExplore: errors for group=source are NOT multiplied by session message count', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'errors', group: 'source', rollup: 'total', topN: 10 });
  const cc = r.rows.find((x) => x.key === 'claude-code');
  assert.ok(cc);
  assert.equal(cc.errors, 2);
});

// Locks Finding 2 (5e-0 review): calibrated tool/skill rows must blend
// tokens across the scope's REAL models (costOf(model) can price them), not
// collapse into a single ''-keyed cell (costOf('') is null per src/models.ts
// pricingFor's falsy-model guard).
test('computeExplore: calibrated tool rows blend tokens across REAL models, never a "" key', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'tool', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, true);
  const bash = r.rows.find((x) => x.key === 'Bash');
  assert.ok(bash);
  const modelKeys = Object.keys(bash.tokensByModel);
  assert.ok(modelKeys.length > 0);
  assert.ok(!modelKeys.includes(''));
  assert.ok(modelKeys.includes('claude-sonnet-5') || modelKeys.includes('claude-haiku-4-5'));
});

// Locks Finding 5 (5e-0 review): calibrated groups skip subgroup segments
// entirely (raw per-row token sums would be near-zero and misleading).
test('computeExplore: calibrated groups (tool/skill) leave segments empty even when subgroup is requested', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'tool', subgroup: 'project', rollup: 'total', topN: 10 });
  const bash = r.rows.find((x) => x.key === 'Bash');
  assert.ok(bash);
  assert.deepEqual(bash.segments, []);
});

// Regression test for the tool_input calibration-char-source bug (5e-1 code
// review, fixed in server/explore.ts): tool_use rows carry their content in
// tool_input, not text — the 't3' fixture row above has text null/absent and
// a non-empty tool_input. Before the fix, the char-length query summed
// LENGTH(text) only, so every tool_use row contributed 0 chars,
// calibrateByBucket's totalChars was 0, and EVERY calibrated tool/skill row
// came out 0 tokens regardless of scope/date range — the prior test only
// checked the 'Bash' row EXISTS (and that its tokensByModel keys are real
// model names), never that its token VALUES were nonzero, so the bug slipped
// through review. This asserts the 'Read' row (t3) has real positive tokens.
test('computeExplore: calibrated tool tokens are nonzero (tool_input counts as char source, not just text)', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'tool', rollup: 'total', topN: 10 });
  assert.equal(r.calibrated, true);
  const read = r.rows.find((x) => x.key === 'Read');
  assert.ok(read);
  const totalTokens = Object.values(read.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  assert.ok(totalTokens > 0, `expected 'Read' row tokens > 0, got ${totalTokens}`);
});

// Locks the calibrated tool/skill BASE to sessions.usage, not per-message
// (review Finding 1). The calibration base (billedAll) is Σ in-scope
// sessions.usage(input+output) = 2660 ((1200+700)+(40+20)+sDup's 500+200);
// the per-message assistant sum diverges (s1 800/380 incl. sidechain + s2
// 600/300 + sDup's own per-message sum). Only the 'Read' tool_use row carries
// chars (t3's tool_input; the Bash rows, including sDup's, have neither text
// nor tool_input → 0 chars), so calibrateByBucket routes the FULL base to
// 'Read'. Its blended token total therefore equals the base exactly: 2660
// under usage — a genuine RED-under-old-code lock on a headline Spend path.
test('computeExplore: calibrated tool base comes from sessions.usage, not per-message', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'tool', rollup: 'total', topN: 10 });
  const read = r.rows.find((x) => x.key === 'Read');
  assert.ok(read);
  const total = Object.values(read.tokensByModel).reduce((n, u) => n + u.input + u.output, 0);
  assert.equal(total, 2660); // usage billedAll, incl. sDup's 700
});

test('duplicate tool_use rows for one tool_use_id do not double-count errors', () => {
  // sDup has ONE erroring tool_result (te1) but TWO tool_use rows sharing
  // tool_use_id 'te1' — the pairing join must attribute exactly ONE error.
  const r = explore.computeExplore({ scope: { type: 'session', id: 'sDup' }, days: null, metric: 'errors', group: 'tool', rollup: 'total', topN: 10 });
  const bash = r.rows.find((x) => x.key === 'Bash');
  assert.equal(bash?.errors, 1, 'one erroring result paired to a duplicated tool_use must count once, not twice');
});

test('tool group Detail tokens are calibrated even under a non-token metric', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'requests', group: 'tool', rollup: 'total', topN: 10 });
  const anyTokens = r.rows.some((row) => Object.values(row.tokensByModel).some((c) => c.input + c.output > 0));
  assert.ok(anyTokens, 'tool rows must carry calibrated tokensByModel under the requests metric');
  assert.equal(r.calibrated, false, 'the ≈ badge flag stays false when the displayed metric is not token-based');
});

test('model group Detail tokens come from usage even under a non-token metric', () => {
  const r = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'errors', group: 'model', rollup: 'total', topN: 10 });
  const sonnet = r.rows.find((row) => row.key === 'claude-sonnet-5');
  const tok = Object.values(sonnet?.tokensByModel ?? {}).reduce((n, c) => n + c.input + c.output, 0);
  // usage totals across s1(1200/700)+s2(...)+sDup(500/200)+... — assert it
  // matches the tokens-metric result exactly (usage override, not per-message).
  const rt = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'model', rollup: 'total', topN: 10 });
  const sonnetT = rt.rows.find((row) => row.key === 'claude-sonnet-5');
  const tokT = Object.values(sonnetT?.tokensByModel ?? {}).reduce((n, c) => n + c.input + c.output, 0);
  assert.equal(tok, tokT, 'model tokensByModel must equal the usage-sourced value regardless of metric');
});

test("metric:spend returns priceable tokensByModel (calibrated for tool, usage for model)", () => {
  const tool = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'spend', group: 'tool', rollup: 'total', topN: 10 });
  assert.equal(tool.calibrated, true, 'spend over tool is calibrated → ≈ badge');
  assert.ok(tool.rows.some((row) => Object.values(row.tokensByModel).some((c) => c.input + c.output > 0)), 'tool spend rows carry non-zero calibrated tokens to price');

  const model = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'spend', group: 'model', rollup: 'total', topN: 10 });
  assert.equal(model.calibrated, false, 'spend over model is exact usage, not calibrated');
  const rt = explore.computeExplore({ scope: { type: 'all' }, days: null, metric: 'tokens', group: 'model', rollup: 'total', topN: 10 });
  assert.deepEqual(
    model.rows.map((r) => r.key).sort(),
    rt.rows.map((r) => r.key).sort(),
    'spend and tokens over model surface the same model rows',
  );
});
