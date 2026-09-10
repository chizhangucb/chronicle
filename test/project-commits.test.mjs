// GET /projects/:id reports the project checkout's commit count, ranged
// (issue #265, finding F3 of the #183 audit).
//
// The route used to count commits with `commitCountSince`, the sync twin of
// the counter Insights already used. The twin is gone and the route awaits
// `commitCountSinceAsync`; this pins the number it answers with, so folding
// the twins cannot quietly change the "Commits" KPI (an unawaited Promise
// included).
//
// Mounts the real route on an ephemeral express server (same pattern as
// test/projects-live.test.mjs) against a real throwaway git repo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import { withTempDb } from './helpers.mjs';

let teardown, server, baseUrl, repoDir, projectId;

// Three commits in the checkout: two inside the trailing 7 days, one a year
// back, so a ranged request and an unranged one must disagree.
function commitAt(dir, iso, file, body) {
  const run = (args, env = {}) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  fs.writeFileSync(path.join(dir, file), body);
  run(['add', '.']);
  run(['commit', '-q', '-m', `at ${iso}`, `--date=${iso}`], { GIT_COMMITTER_DATE: iso });
}

before(async () => {
  const temp = await withTempDb();
  teardown = temp.teardown;
  const { upsertProject, replaceSession } = temp.dbModule;
  const { mountProjects } = await import('../server/routes/projects.ts');

  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-commits-'));
  const run = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@test.com']);
  run(['config', 'user.name', 'Test']);
  const now = Date.now();
  const DAY = 86400000;
  commitAt(repoDir, new Date(now - 400 * DAY).toISOString(), 'a.txt', '1');
  commitAt(repoDir, new Date(now - 3 * DAY).toISOString(), 'a.txt', '2');
  commitAt(repoDir, new Date(now - 1 * DAY).toISOString(), 'a.txt', '3');

  const project = upsertProject(repoDir);
  projectId = project.id;
  // One non-minor session (12 messages, 2-min spacing clears the noise gate)
  // so the project page has something to range over.
  const events = [];
  for (let i = 0; i < 12; i++) {
    events.push({ kind: i % 2 === 0 ? 'user' : 'assistant', text: `msg ${i}`, ts: new Date(now - 2 * DAY + i * 2 * 60000).toISOString() });
  }
  replaceSession(
    { id: 's_commits', project_id: projectId, source: 'claude-code', file_path: path.join(repoDir, 'a.txt'),
      started_at: new Date(now - 2 * DAY).toISOString(), ended_at: new Date(now - 2 * DAY + 22 * 60000).toISOString() },
    events,
  );

  const app = express();
  const api = express.Router();
  mountProjects(api);
  app.use('/api', api);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server?.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
  teardown?.();
});

test('unranged: every commit in the checkout', async () => {
  const res = await fetch(`${baseUrl}/projects/${projectId}`);
  const body = await res.json();
  assert.equal(body.analytics.commits, 3);
});

test('ranged: only the commits inside the range cutoff', async () => {
  const res = await fetch(`${baseUrl}/projects/${projectId}?days=7`);
  const body = await res.json();
  assert.equal(body.analytics.commits, 2);
});

test('a project that is not a git checkout counts 0, and still answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-project-nogit-'));
  const { upsertProject } = await import('../server/db.ts');
  const p = upsertProject(dir);
  const res = await fetch(`${baseUrl}/projects/${p.id}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.analytics.commits, 0);
  assert.equal(body.git.isRepo, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
