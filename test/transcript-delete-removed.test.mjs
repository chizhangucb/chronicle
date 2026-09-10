// Removal pin for #299: Chronicle has no route that removes a source
// transcript. ADR 0008's floor ("never mutate a source transcript") had two
// holes -- DELETE /sessions/:id/source-file and the ?source=1 branch on
// session delete -- and both are gone.
//
// Asserted over HTTP against the real sessions router, because the observable
// is what an API client gets back and what is left on disk afterwards, not the
// shape of the module. "Remove Chronicle's copy" is asserted in the same run,
// tombstone included, so a wholesale unmount cannot pass this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { withTempDb } from './helpers.mjs';

const SOURCE = 'claude-code';

let dbModule;
let dir;
let teardown;
let server;
let baseUrl;

// Ends long before the live window, so the session is never a live candidate
// and the delete routes answer on their own merits.
function events() {
  return [
    { kind: 'user', text: 'hi', ts: '2026-01-01T00:00:00.000Z' },
    { kind: 'assistant', text: 'hello', ts: '2026-01-01T00:00:01.000Z' },
  ];
}

// One imported session with a real transcript file on disk under the temp dir.
function seedSession(id) {
  const project = dbModule.upsertProject(path.join(dir, 'proj'));
  const filePath = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(filePath, '{"seeded":true}\n');
  const session = {
    id, project_id: project.id, source: SOURCE, file_path: filePath,
    started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:01.000Z',
  };
  dbModule.replaceSession(session, events());
  return { session, filePath };
}

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  dir = temp.dir;
  teardown = temp.teardown;
  const { mountSessions } = await import('../server/routes/sessions.ts');
  const app = express();
  app.use(express.json());
  mountSessions(app);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  teardown();
});

test('DELETE /sessions/:id/source-file is unmounted and leaves the transcript on disk', async () => {
  const { session, filePath } = seedSession('s-source-file');
  const res = await fetch(`${baseUrl}/sessions/${session.id}/source-file`, { method: 'DELETE' });
  assert.equal(res.status, 404, `the source-file route answered ${res.status}, not 404`);
  assert.equal(fs.existsSync(filePath), true, 'the source transcript was removed from disk');
});

test('?source=1 on session delete removes only Chronicle\'s copy', async () => {
  const { session, filePath } = seedSession('s-source-query');
  const res = await fetch(`${baseUrl}/sessions/${session.id}?source=1`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.equal(fs.existsSync(filePath), true, 'the source transcript was removed from disk');
  const body = await res.json();
  assert.equal('sourceDeleted' in body, false, 'the response still reports a source deletion');
  assert.equal(dbModule.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id), undefined);
});

test('session delete tombstones, so a following sync does not resurrect it', async () => {
  const { session, filePath } = seedSession('s-tombstone');
  const res = await fetch(`${baseUrl}/sessions/${session.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, source: SOURCE, projectId: session.project_id });
  assert.equal(fs.existsSync(filePath), true, 'the source transcript was removed from disk');
  assert.equal(dbModule.isTombstoned(SOURCE, session.id), true);

  // A following sync re-parses the same transcript into the same session.
  dbModule.replaceSession(session, events());
  assert.equal(dbModule.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id), undefined,
    'a tombstoned session was resurrected by the next sync');
});
