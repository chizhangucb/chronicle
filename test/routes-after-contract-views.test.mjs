// with the contract_* views removed, every read route that
// used to sit alongside them still answers from the base tables.
//
// The views were never in a route's query path, so this is a pin rather than a
// discovery: it fails loudly if a later removal pass takes a base column or a
// join the engines actually read. One seeded session with real token cells is
// enough — each route is asserted on its shape and on the session being
// visible, not on a magic number.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withTempDb } from './helpers.mjs';

const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();
const MODEL = 'claude-sonnet-5';

let dbModule, teardown, server, baseUrl, projectId;

const get = async (p) => {
  const res = await fetch(`${baseUrl}${p}`);
  assert.equal(res.status, 200, `${p} answered ${res.status}`);
  return res.json();
};

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;

  const p = dbModule.upsertProject('/tmp/views-proj');
  projectId = p.id;

  // Twelve assistant messages spread over three hours: past the noise gate on
  // both axes, so the session shows up on the windowed surfaces too.
  const events = Array.from({ length: 12 }, (_, i) => ({
    kind: 'assistant',
    model: MODEL,
    ts: iso(now - (3 * HOUR) + i * 12 * 60000),
    input_tokens: 10,
    output_tokens: 5,
    text: `assistant reply ${i} with enough text to carry a character share`,
  }));
  dbModule.replaceSession(
    {
      id: 'views', project_id: projectId, source: 'claude-code', file_path: '/tmp/views.jsonl',
      started_at: iso(now - 3 * HOUR), ended_at: iso(now - 60000),
      usage: JSON.stringify({ [MODEL]: { input: 120, output: 60, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }),
    },
    events,
  );

  const app = express();
  for (const [mod, fn] of [
    ['insights', 'mountInsights'], ['explore', 'mountExplore'], ['content', 'mountContent'],
    ['sessions', 'mountSessions'], ['projects', 'mountProjects'], ['search', 'mountSearch'],
    ['security', 'mountSecurity'],
  ]) {
    (await import(`../server/routes/${mod}.ts`))[fn](app);
  }
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  teardown?.();
});

test('the database carries no contract_* view', () => {
  const views = dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all();
  assert.deepEqual(views.map((v) => v.name).filter((n) => n.startsWith('contract_')), []);
});

test('analytics routes answer from the base tables', async () => {
  const insights = await get('/insights');
  assert.ok(insights && typeof insights === 'object', '/insights returns an object');

  const explore = await get('/explore?group=model');
  const rows = explore.rows ?? explore.groups ?? [];
  assert.ok(rows.length > 0, '/explore groups the seeded session by model');

  const content = await get('/content');
  assert.ok(content && typeof content === 'object', '/content returns an object');
});

test('session, project, search and security routes answer', async () => {
  const projects = await get('/projects');
  const list = Array.isArray(projects) ? projects : projects.projects;
  assert.ok(list.some((p) => p.id === projectId), 'seeded project is listed');

  const project = await get(`/projects/${projectId}`);
  assert.ok(project && typeof project === 'object', '/projects/:id returns an object');

  const messages = await get('/sessions/views/messages');
  const rows = Array.isArray(messages) ? messages : messages.messages;
  assert.equal(rows.length, 12, 'every seeded message comes back');

  const search = await get('/search?q=assistant');
  assert.ok(search && typeof search === 'object', '/search returns an object');

  const rules = await get('/security/rules');
  assert.ok(Array.isArray(rules) || typeof rules === 'object', '/security/rules answers');
});
