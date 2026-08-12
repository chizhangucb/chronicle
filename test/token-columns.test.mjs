import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupShowsTokenColumn } from '../src/explore/tokenColumns.ts';

// The Detail Tokens column shows a concrete number for groups whose token
// magnitude the app treats as real: model/project/source (authoritative billed
// cells from sessions.usage) AND subagent/hour (per-message token columns,
// shown UNMARKED on the card/bar — server sets result.calibrated only for
// tool/skill, so `—` here would contradict the card).
test('groupShowsTokenColumn: real-number groups', () => {
  assert.equal(groupShowsTokenColumn('model'), true);
  assert.equal(groupShowsTokenColumn('project'), true);
  assert.equal(groupShowsTokenColumn('source'), true);
  assert.equal(groupShowsTokenColumn('subagent'), true);
  assert.equal(groupShowsTokenColumn('hour'), true);
});

// tool/skill are the ONLY calibrated exceptions: token magnitude is estimated
// from message-text length and the card carries the `≈` badge, so the Detail
// Tokens column suppresses to `—` (EXP-02). Note $/session is NOT gated by this
// predicate — it is spend-derived and shows for every group.
test('groupShowsTokenColumn: calibrated groups suppress Tokens to — (EXP-02)', () => {
  assert.equal(groupShowsTokenColumn('tool'), false);
  assert.equal(groupShowsTokenColumn('skill'), false);
});
