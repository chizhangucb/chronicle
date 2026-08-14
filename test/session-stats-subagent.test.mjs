import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subagentRuns, subagentRunCount, subagentRunList } from '../src/session/stats.ts';

test('subagentRuns: groups sidechain assistant turns by agent_type with exact token sums', () => {
  const messages = [
    { kind: 'assistant', is_sidechain: 0, model: 'x' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', input_tokens: 100, output_tokens: 40 },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', input_tokens: 60, output_tokens: 10 },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'Explore', input_tokens: 20, output_tokens: 5 },
  ];
  const runs = subagentRuns(messages);
  const gp = runs.find((r) => r.agentType === 'general-purpose');
  assert.equal(gp.turns, 2);
  assert.equal(gp.inputTokens, 160);
  assert.equal(gp.outputTokens, 50);
  assert.ok(runs.find((r) => r.agentType === 'Explore'));
});
test('subagentRuns: no sidechains → empty', () => {
  assert.deepEqual(subagentRuns([{ kind: 'assistant', is_sidechain: 0 }]), []);
});
test('subagentRuns: non-assistant sidechain rows (tool_use/tool_result) carry agent_type too but must not inflate turns', () => {
  const messages = [
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', input_tokens: 100, output_tokens: 40 },
    { kind: 'tool_use', is_sidechain: 1, agent_type: 'general-purpose' },
    { kind: 'tool_result', is_sidechain: 1, agent_type: 'general-purpose' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', input_tokens: 60, output_tokens: 10 },
    { kind: 'tool_use', is_sidechain: 1, agent_type: 'general-purpose' },
  ];
  const runs = subagentRuns(messages);
  const gp = runs.find((r) => r.agentType === 'general-purpose');
  assert.equal(gp.turns, 2);
  assert.equal(gp.inputTokens, 160);
  assert.equal(gp.outputTokens, 50);
});

// subagentRunCount: the Overview Subagents card HEADER count — distinct RUNS
// (agent_id), not distinct KINDS (agent_type, which subagentRuns groups by).
test('subagentRunCount: counts distinct agent_id, not distinct agent_type — many runs of one type all count', () => {
  const messages = [
    { kind: 'user', is_sidechain: 1, agent_type: 'workflow-subagent', agent_id: 'a1' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'workflow-subagent', agent_id: 'a1' },
    { kind: 'user', is_sidechain: 1, agent_type: 'workflow-subagent', agent_id: 'a2' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'workflow-subagent', agent_id: 'a2' },
    { kind: 'user', is_sidechain: 1, agent_type: 'workflow-subagent', agent_id: 'a3' },
  ];
  // All 3 runs share one agent_type, so subagentRuns() (grouped by type)
  // would report just 1 row — subagentRunCount must still report 3.
  assert.equal(subagentRuns(messages).length, 1);
  assert.equal(subagentRunCount(messages), 3);
});

test('subagentRunCount: non-sidechain rows and rows without agent_id are ignored', () => {
  const messages = [
    { kind: 'assistant', is_sidechain: 0, agent_id: 'not-a-run' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a1' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a1' }, // same run, repeated row
  ];
  assert.equal(subagentRunCount(messages), 1);
});

test('subagentRunCount: falls back to the agent_type-group count when every sidechain row has a null agent_id (pre-migration imports)', () => {
  const messages = [
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: null },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: null },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'Explore', agent_id: null },
  ];
  assert.equal(subagentRunCount(messages), subagentRuns(messages).length);
  assert.equal(subagentRunCount(messages), 2);
});

test('subagentRunCount: no sidechains at all → 0', () => {
  assert.equal(subagentRunCount([{ kind: 'assistant', is_sidechain: 0 }]), 0);
});

// D3 (Task 11): per-type run count — the row label is "<type> · N runs",
// distinct from `turns` (assistant message count) and from the header's
// whole-session run count (subagentRunCount).
test('subagentRuns: runCount is the distinct agent_id count per type, not turns', () => {
  const messages = [
    { kind: 'user', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a1' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a1', input_tokens: 10, output_tokens: 5 },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a1', input_tokens: 10, output_tokens: 5 },
    { kind: 'user', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a2' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a2', input_tokens: 20, output_tokens: 8 },
  ];
  const runs = subagentRuns(messages);
  const gp = runs.find((r) => r.agentType === 'general-purpose');
  assert.equal(gp.runCount, 2); // a1 + a2
  assert.equal(gp.turns, 3);    // 3 assistant rows total
});

test('subagentRuns: runCount falls back to 1 when every row of a type has no agent_id (pre-migration)', () => {
  const messages = [
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: null, input_tokens: 5, output_tokens: 1 },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: null, input_tokens: 5, output_tokens: 1 },
  ];
  const gp = subagentRuns(messages).find((r) => r.agentType === 'general-purpose');
  assert.equal(gp.runCount, 1);
});

// D3: subagentRunList — the RUN LIST for one type (SessionView's level-1
// drill-in), one row per agent_id, sorted by start time, with description
// carried over from any row that has it (agent_desc, per-run).
test('subagentRunList: groups by agent_id within a type, sorted by start ts, carries description/tokens/turns', () => {
  const messages = [
    // Run a2 (later start) — no description.
    { kind: 'user', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a2', ts: '2026-08-01T01:00:00.000Z' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a2', ts: '2026-08-01T01:00:05.000Z', input_tokens: 7, output_tokens: 2 },
    // Run a1 (earlier start) — has a description.
    { kind: 'user', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a1', ts: '2026-08-01T00:00:00.000Z', agent_desc: 'Investigate module 1' },
    { kind: 'assistant', is_sidechain: 1, agent_type: 'general-purpose', agent_id: 'a1', ts: '2026-08-01T00:00:10.000Z', agent_desc: 'Investigate module 1', input_tokens: 10, output_tokens: 5 },
    // A different type must not leak into this list.
    { kind: 'assistant', is_sidechain: 1, agent_type: 'Explore', agent_id: 'a3', ts: '2026-08-01T00:30:00.000Z', input_tokens: 99, output_tokens: 99 },
  ];
  const runs = subagentRunList(messages, 'general-purpose');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].id, 'a1'); // earlier start sorts first
  assert.equal(runs[0].description, 'Investigate module 1');
  assert.equal(runs[0].startTs, '2026-08-01T00:00:00.000Z');
  assert.equal(runs[0].endTs, '2026-08-01T00:00:10.000Z');
  assert.equal(runs[0].turns, 1);
  assert.equal(runs[0].inputTokens, 10);
  assert.equal(runs[1].id, 'a2');
  assert.equal(runs[1].description, null);
  assert.ok(!runs.some((r) => r.id === 'a3'));
});

test('subagentRunList: unknown type or no messages → empty', () => {
  assert.deepEqual(subagentRunList([], 'general-purpose'), []);
  assert.deepEqual(subagentRunList([{ kind: 'assistant', is_sidechain: 1, agent_type: 'Explore', agent_id: 'x' }], 'general-purpose'), []);
});
