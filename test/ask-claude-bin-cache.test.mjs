// Ticket #274: the claude-binary probe cache in server/ask.ts is the shared
// server cache (server/cache.ts) with a TTL, not a private one-slot map.
//
// It exists because /ask/status is an unauthenticated GET a poll loop could
// hammer and each probe spawns `which`. Its input is the filesystem, not the
// database, so the TTL is its whole staleness rule: the third test pins that a
// DB write does not throw the probe away, which is what would happen if the
// fold had left it generation-keyed as well (autosync imports every few
// seconds, and /ask/status polls).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { findClaudeBin } from '../server/ask.ts';
import { invalidateCache } from '../server/cache.ts';

// CHRONICLE_CLAUDE_BIN short-circuits the probe (server/ask.ts), which is what
// makes the probe's answer observable here without a claude CLI on the box.
afterEach(() => {
  delete process.env.CHRONICLE_CLAUDE_BIN;
});

test('findClaudeBin: a custom env is probed fresh every call, never memoized', () => {
  assert.equal(findClaudeBin({ CHRONICLE_CLAUDE_BIN: '/tmp/claude-a' }), '/tmp/claude-a');
  assert.equal(findClaudeBin({ CHRONICLE_CLAUDE_BIN: '/tmp/claude-b' }), '/tmp/claude-b');
});

test('findClaudeBin: the default-env probe is cached', () => {
  process.env.CHRONICLE_CLAUDE_BIN = '/tmp/claude-first';
  assert.equal(findClaudeBin(), '/tmp/claude-first');
  process.env.CHRONICLE_CLAUDE_BIN = '/tmp/claude-second';
  assert.equal(findClaudeBin(), '/tmp/claude-first', 'the probe re-ran inside its TTL');
});

test('findClaudeBin: a DB write does not throw the probe away', () => {
  process.env.CHRONICLE_CLAUDE_BIN = '/tmp/claude-first';
  assert.equal(findClaudeBin(), '/tmp/claude-first');
  process.env.CHRONICLE_CLAUDE_BIN = '/tmp/claude-second';
  invalidateCache();
  assert.equal(findClaudeBin(), '/tmp/claude-first', 'an import evicted a cache the database has nothing to say about');
});
