import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupHasPerModelTokens } from '../src/explore/tokenColumns.ts';

// Only model/project/source carry authoritative per-model token cells
// (server EXACT_USAGE_GROUPS, sourced from sessions.usage). tool/skill are
// calibrated; subagent/hour are per-message approximations — none authoritative.
test('groupHasPerModelTokens: authoritative groups', () => {
  assert.equal(groupHasPerModelTokens('model'), true);
  assert.equal(groupHasPerModelTokens('project'), true);
  assert.equal(groupHasPerModelTokens('source'), true);
});

test('groupHasPerModelTokens: calibrated / approximate groups render — (EXP-02)', () => {
  assert.equal(groupHasPerModelTokens('tool'), false);
  assert.equal(groupHasPerModelTokens('skill'), false);
  assert.equal(groupHasPerModelTokens('subagent'), false);
  assert.equal(groupHasPerModelTokens('hour'), false);
});
