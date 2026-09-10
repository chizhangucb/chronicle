// Ticket #274: the claude-binary probe memo in server/ask.ts is the shared
// server cache (server/cache.ts) with a TTL, not a private one-slot map.
//
// The memo exists because /ask/status is an unauthenticated GET a poll loop
// could hammer and each probe spawns `which`. What the fold changes, and what
// the third test pins, is that the memo now also answers to invalidateCache():
// the private map ignored it, so the only way out of a stale probe was to wait
// out the TTL.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { findClaudeBin } from '../server/ask.ts';
import { invalidateCache } from '../server/cache.ts';

// CHRONICLE_CLAUDE_BIN short-circuits the probe (server/ask.ts), which is what
// makes the probe's answer observable here without a claude CLI on the box.
afterEach(() => {
  delete process.env.CHRONICLE_CLAUDE_BIN;
  invalidateCache();
});

test('findClaudeBin: a custom env is probed fresh every call, never memoized', () => {
  assert.equal(findClaudeBin({ CHRONICLE_CLAUDE_BIN: '/tmp/claude-a' }), '/tmp/claude-a');
  assert.equal(findClaudeBin({ CHRONICLE_CLAUDE_BIN: '/tmp/claude-b' }), '/tmp/claude-b');
});

test('findClaudeBin: the default-env probe is memoized', () => {
  process.env.CHRONICLE_CLAUDE_BIN = '/tmp/claude-first';
  assert.equal(findClaudeBin(), '/tmp/claude-first');
  process.env.CHRONICLE_CLAUDE_BIN = '/tmp/claude-second';
  assert.equal(findClaudeBin(), '/tmp/claude-first', 'the probe re-ran inside its TTL');
});

test('findClaudeBin: invalidateCache() drops the memo', () => {
  process.env.CHRONICLE_CLAUDE_BIN = '/tmp/claude-first';
  assert.equal(findClaudeBin(), '/tmp/claude-first');
  process.env.CHRONICLE_CLAUDE_BIN = '/tmp/claude-second';
  invalidateCache();
  assert.equal(findClaudeBin(), '/tmp/claude-second', 'the probe memo outlived an invalidation');
});
