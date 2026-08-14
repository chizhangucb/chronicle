// Task 16 (feedback round, D9): Chi reported no live dot on `/projects` while
// actively working via the Claude Code CLI. Root cause: GET /api/projects'
// `live` flag only checked (a) an open Chronicle SSE watcher or (b) a stored
// `ended_at` within the trailing 5 minutes — both of which only update when
// someone has the session open in Chronicle, or after an import runs. A
// running CLI session that nobody has open in Chronicle has neither: no
// watcher (nobody attached), and `ended_at` is import-time-stale. But its
// source log file keeps getting written to, so the fix adds a source-log
// freshness check: stat the most-recently-started session's file per
// project (one stat per project, not per session) and mark the project live
// if that file was written in the last 5 minutes.
//
// This mounts the real GET /projects route on an ephemeral express server
// (same pattern as test/activity-endpoint.test.mjs) so the SQL + fs.stat
// logic is exercised end-to-end, not reimplemented in the test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, server, baseUrl, logDir;

// 12 messages / 2-min spacing = well over the noise-gate's 5-min-active AND
// 10-message thresholds, so these fixture sessions land as non-minor (see
// server/noiseGate.ts) and are visible to the /projects aggregation query.
function rhythmEvents(baseMs) {
  const events = [];
  for (let i = 0; i < 12; i++) {
    events.push({ kind: i % 2 === 0 ? 'user' : 'assistant', text: `msg ${i}`, ts: new Date(baseMs + i * 2 * 60000).toISOString() });
  }
  return events;
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  const { upsertProject, replaceSession } = dbModule;
  const { mountProjects } = await import('../server/routes/projects.ts');

  logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-live-test-'));
  const freshFile = path.join(logDir, 'fresh.jsonl');
  const staleFile = path.join(logDir, 'stale.jsonl');
  fs.writeFileSync(freshFile, '');
  fs.writeFileSync(staleFile, '');

  const now = Date.now();
  const HOUR = 3600000;

  // Both sessions' ended_at is well outside the 5-min "recently ended" window
  // and neither has an open live watcher registered (this test never opens
  // an SSE stream) — so the OLD live logic would mark both projects NOT live.
  const pFresh = upsertProject('/tmp/proj-live-fresh');
  replaceSession(
    { id: 's_fresh', project_id: pFresh.id, source: 'claude-code', file_path: freshFile,
      started_at: new Date(now - HOUR).toISOString(), ended_at: new Date(now - HOUR).toISOString() },
    rhythmEvents(now - HOUR),
  );
  // Freshly-written source log (mtime ~now) — an active CLI session nobody
  // has open in Chronicle.
  fs.utimesSync(freshFile, new Date(), new Date());

  const pStale = upsertProject('/tmp/proj-live-stale');
  replaceSession(
    { id: 's_stale', project_id: pStale.id, source: 'claude-code', file_path: staleFile,
      started_at: new Date(now - HOUR).toISOString(), ended_at: new Date(now - HOUR).toISOString() },
    rhythmEvents(now - HOUR),
  );
  // Stale source log (mtime 1h ago) — genuinely inactive, must NOT flip live.
  const staleTime = new Date(now - HOUR);
  fs.utimesSync(staleFile, staleTime, staleTime);

  const app = express();
  app.use(express.json());
  mountProjects(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  teardown?.();
  if (logDir) fs.rmSync(logDir, { recursive: true, force: true });
});

async function getProjects() {
  const res = await fetch(`${baseUrl}/projects`);
  assert.equal(res.status, 200);
  return res.json();
}

test('project whose most-recent session source file was just written is live, with no open watcher and a stale ended_at', async () => {
  const projects = await getProjects();
  const p = projects.find((x) => x.path === '/tmp/proj-live-fresh');
  assert.ok(p, 'fresh project present');
  assert.equal(p.live, true);
});

test('project whose most-recent session source file is stale stays not-live (no regression)', async () => {
  const projects = await getProjects();
  const p = projects.find((x) => x.path === '/tmp/proj-live-stale');
  assert.ok(p, 'stale project present');
  assert.equal(p.live, false);
});
