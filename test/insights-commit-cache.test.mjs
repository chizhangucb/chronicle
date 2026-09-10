// Ticket #274: the Insights engine's per-project commit count is cached
// through server/cache.ts under a TTL, not a private map in
// server/insights.ts.
//
// The cache exists because `computeInsights` spawns one `git rev-list --count`
// per project on every request, 26 of them on the maintainer's machine, so a
// range click that misses re-spawns the lot. Its input is Git, which is why it
// takes a TTL rather than the generation: an import says nothing about a
// commit count, and autosync imports a live session every few seconds, so
// generation-keying it would throw the answer away before it ever paid for
// itself. Both tests below pass the SAME `range`, which is what holds the
// cache key steady (the cutoff is quantized to 5 minutes).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withTempDb } from './helpers.mjs';
import { rangeOf } from '../server/scope.ts';

let dbModule, teardown, insightsModule, repo;

const BASE = new Date(Date.now() - 2 * 86400000);
BASE.setUTCHours(10, 0, 0, 0);

// 12 messages, 2 minutes apart: comfortably clear of the noise gate's 5-min /
// 10-message minor thresholds, so the session is visible to every aggregate.
const rhythmEvents = (startMs) => Array.from({ length: 12 }, (_, i) => ({
  kind: i % 2 === 0 ? 'user' : 'assistant',
  text: `msg ${i}`,
  ts: new Date(startMs + i * 2 * 60000).toISOString(),
  ...(i % 2 === 1 ? { model: 'claude-sonnet-5' } : {}),
}));

const inRepo = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

// One commit, dated now, so it lands inside every range the tests ask for.
function commit(message) {
  fs.writeFileSync(path.join(repo, 'a.txt'), message);
  inRepo('add', '.');
  inRepo('commit', '-q', '-m', message);
}

function addSession(id, projectId, startMs) {
  dbModule.replaceSession(
    {
      id, project_id: projectId, source: 'claude-code', file_path: `/tmp/${id}.jsonl`,
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date(startMs + 22 * 60000).toISOString(),
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 100, output: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }),
    },
    rhythmEvents(startMs),
  );
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  insightsModule = await import('../server/insights.ts');

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-commit-cache-'));
  inRepo('init', '-q');
  inRepo('config', 'user.email', 'test@test.com');
  inRepo('config', 'user.name', 'Test');
  commit('first');

  addSession('c1', dbModule.upsertProject(repo).id, BASE.getTime());
});

after(() => {
  teardown();
  fs.rmSync(repo, { recursive: true, force: true });
});

test('the commit count is cached: a new commit is not re-counted inside the TTL', async () => {
  const range = rangeOf(7);
  const first = await insightsModule.computeInsights({ type: 'all' }, range);
  assert.equal(first.commits, 1);
  commit('second');
  const second = await insightsModule.computeInsights({ type: 'all' }, range);
  assert.equal(second.commits, 1, 'git was re-spawned instead of the cached count being read');
});

test('an import does not throw the commit count away', async () => {
  const range = rangeOf(7);
  const before_ = await insightsModule.computeInsights({ type: 'all' }, range);
  assert.equal(before_.commits, 1);
  // A second project, so the import is a real DB write that bumps the cache
  // generation. The commit count is Git data, so it must survive it.
  addSession('c2', dbModule.upsertProject('/tmp/no-such-repo').id, BASE.getTime() + 86400000);
  const after_ = await insightsModule.computeInsights({ type: 'all' }, range);
  assert.equal(after_.commits, 1, 'an import re-spawned the git fan-out the cache exists to avoid');
});
