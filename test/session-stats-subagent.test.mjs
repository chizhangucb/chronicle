import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subagentRuns, subagentRunCount } from '../src/session/stats.ts';

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
