import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subagentRuns } from '../src/session/stats.ts';

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
