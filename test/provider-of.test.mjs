// Pins the client provider (model-vendor) mapping to the server SQL cases in
// server/explore.ts providerExpr (CHI-324 D6). If the SQL prefix rules change,
// this must change with them — the two sides MUST agree, else the Explore
// `provider` dimension and the spend chart's provider stack would disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerOf, PROVIDER_ORDER } from '../shared/provider.ts';

test('providerOf mirrors the explore.ts providerExpr prefix cases', () => {
  assert.equal(providerOf('claude-opus-4-8'), 'anthropic');
  assert.equal(providerOf('claude-fable-5'), 'anthropic');
  assert.equal(providerOf('gpt-5.6'), 'openai');
  assert.equal(providerOf('codex-mini'), 'openai');
  assert.equal(providerOf('o1-preview'), 'openai');
  assert.equal(providerOf('o3'), 'openai');
  assert.equal(providerOf('o4-mini'), 'openai');
  assert.equal(providerOf('gemini-2.5-pro'), 'google');
  assert.equal(providerOf('some-local-llama'), 'other');
  assert.equal(providerOf('<synthetic>'), 'other');
});

test('providerOf is case-insensitive (models are lowercased first)', () => {
  assert.equal(providerOf('CLAUDE-OPUS'), 'anthropic');
  assert.equal(providerOf('GPT-5'), 'openai');
});

test('PROVIDER_ORDER is the fixed categorical order', () => {
  assert.deepEqual(PROVIDER_ORDER, ['anthropic', 'openai', 'google', 'other']);
});
