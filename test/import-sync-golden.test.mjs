// Route golden for the `Source` contract slice (#309), the import and sync half.
//
// Import, autosync and live stop branching on the source string and consume the
// `Source` interface instead. That is a re-plumbing, not a behaviour change, so
// the pin is equality with what the routes returned BEFORE it: GET /scan,
// POST /import, POST /projects/:id/sync and POST /sessions/:id/sync, over the
// committed parser fixtures, deep-compared against
// test/fixtures/import-sync-golden.json, captured on the pre-slice commit.
// (Sessions and messages are pinned by test/route-golden.test.mjs.)
//
// Determinism, so a committed golden stays true tomorrow:
//   - every source reads a committed fixture, never this machine's real logs:
//     HOME is a temp dir (so ~/.claude, ~/.codex and ~/.local/share/opencode
//     resolve under it) with the Claude Code fixture copied into
//     ~/.claude/projects, and CHRONICLE_CURSOR_DIR points at the Cursor
//     fixture. The parsers read those roots at import time, so the env is set
//     before the first dynamic import;
//   - absolute paths are scrubbed to <home>/<repo>/<data> tokens, and the times
//     stamped by the machine rather than by the fixtures (a scanned file's
//     modifiedAt, the DB's created_at/imported_at) to <seeded>, before
//     comparing.
//
// The slice's intended differences are the only changes in this file's golden,
// each one a consequence of the interface deciding what the route used to:
//   - a Cursor scan item carries the `root` it was scanned under, because
//     `Source.scan` stamps it so a scanned item is a complete parse target
//     (#308). Additive;
//   - a target that names nothing readable now imports nothing (200,
//     `imported: 0`) instead of the route rejecting it (400 'Log directory not
//     found'). The route cannot tell the two apart without naming a source:
//     Cursor's Agent-transcript target legitimately names a directory that need
//     not exist, and only Cursor's parse knows that;
//   - a Codex import that names a log dir and no files reads that dir's
//     transcripts, the way a Claude Code one always did, instead of importing
//     nothing.
// Every other key is byte-identical to the pre-slice capture.
// Regenerate (only when import/sync JSON is meant to change) with
// `UPDATE_IMPORT_SYNC_GOLDEN=1 node --test test/import-sync-golden.test.mjs`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { withTempDb } from './helpers.mjs';

process.env.TZ = 'UTC';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');
const GOLDEN_PATH = path.join(FIXTURES, 'import-sync-golden.json');
const UPDATE = process.env.UPDATE_IMPORT_SYNC_GOLDEN === '1';

let teardown, server, baseUrl, home, dataDir;
let projectId, sessionId, codexFile, cursorWorkspace;

async function call(method, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  // A fake HOME, so every parser's default root resolves into the fixtures
  // rather than onto the machine running the test.
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CHRONICLE_CURSOR_DIR = path.join(FIXTURES, 'cursor-user');
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'fixture-project'), { recursive: true });
  for (const f of fs.readdirSync(path.join(FIXTURES, 'claude-code'))) {
    const src = path.join(FIXTURES, 'claude-code', f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(home, '.claude', 'projects', 'fixture-project', f));
  }
  codexFile = path.join(FIXTURES, 'codex-sessions', '2026', '07', '01', 'rollout-2026-07-01T10-00-00-abc.jsonl');
  cursorWorkspace = path.join(FIXTURES, 'cursor-user', 'workspaceStorage');
  const ws = fs.readdirSync(cursorWorkspace, { withFileTypes: true }).find((d) => d.isDirectory());
  cursorWorkspace = path.join(cursorWorkspace, ws.name);

  const temp = await withTempDb();
  teardown = temp.teardown;
  dataDir = temp.dir;
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const { mountImportSync } = await import('../server/routes/import-sync.ts');
  mountImportSync(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  teardown?.();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

// Absolute paths and DB-stamped times are the only parts of these responses
// that are a function of where and when the test ran rather than of the
// fixtures. Tokenize them (keeping the key and the path's tail, so a route
// dropping or re-rooting one still fails).
const SEED_STAMPED = new Set(['created_at', 'imported_at', 'modifiedAt']);
function scrub(value) {
  if (typeof value === 'string') {
    return value.split(home).join('<home>').split(dataDir).join('<data>').split(REPO_ROOT).join('<repo>');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SEED_STAMPED.has(k) ? '<seeded>' : scrub(v)]));
  }
  return value;
}

test('import and sync answer what the pre-slice commit answered', async () => {
  const captured = {};
  const record = (name, result) => { captured[name] = scrub(result); };

  // Scan: the default roots (every source at once) and one manual per-source dir.
  record('GET /scan', await call('GET', '/scan'));
  record('GET /scan?source=codex', await call('GET', `/scan?source=codex&dir=${encodeURIComponent(path.join(FIXTURES, 'codex-sessions'))}`));
  record('GET /scan?source=opencode', await call('GET', `/scan?source=opencode&dir=${encodeURIComponent(path.join(FIXTURES, 'oc-live.db'))}`));
  record('GET /scan?source=cursor', await call('GET', `/scan?source=cursor&dir=${encodeURIComponent(path.join(FIXTURES, 'cursor-user'))}`));
  record('GET /scan?source=nope', await call('GET', '/scan?source=nope&dir=/tmp'));

  // Import: one call per source, each pointed at its fixture.
  const claudeLogDir = path.join(home, '.claude', 'projects', 'fixture-project');
  const claudeImport = await call('POST', '/import', { source: 'claude-code', logDir: claudeLogDir });
  record('POST /import claude-code', claudeImport);
  record('POST /import codex', await call('POST', '/import', { source: 'codex', files: [codexFile] }));
  record('POST /import opencode', await call('POST', '/import', {
    source: 'opencode', logDir: path.join(FIXTURES, 'oc-live.db'), directory: '/tmp/oc-live-project',
  }));
  record('POST /import cursor', await call('POST', '/import', {
    source: 'cursor', logDir: cursorWorkspace, physicalPath: '/tmp/cursor-fixture-project',
  }));
  record('POST /import unsupported', await call('POST', '/import', { source: 'nope' }));
  // A target that names nothing readable: the two shapes where a source's
  // parse, not the route, decides there is nothing there.
  record('POST /import claude-code missing dir', await call('POST', '/import', {
    source: 'claude-code', logDir: path.join(home, 'no-such-dir'),
  }));
  record('POST /import codex logDir only', await call('POST', '/import', {
    source: 'codex', logDir: path.join(FIXTURES, 'codex-sessions'),
  }));

  // Sync: the project the Claude Code fixture imported into, then one of its
  // sessions, then the two not-found paths.
  projectId = claudeImport.body.projectId;
  assert.ok(projectId, 'the Claude Code fixture did not import into a project');
  record('POST /projects/:id/sync', await call('POST', `/projects/${projectId}/sync`));
  record('POST /projects/999/sync', await call('POST', '/projects/999/sync'));

  const { getDb } = await import('../server/db.ts');
  const db = getDb();
  sessionId = db.prepare("SELECT id FROM sessions WHERE source = 'claude-code' ORDER BY id LIMIT 1").get().id;
  record('POST /sessions/:id/sync', await call('POST', `/sessions/${sessionId}/sync`));
  record('POST /sessions/nope/sync', await call('POST', '/sessions/nope/sync'));

  if (UPDATE) {
    fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(captured, null, 2)}\n`);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
  for (const name of Object.keys(captured)) {
    assert.deepEqual(captured[name], golden[name], `${name} changed shape or numbers`);
  }
  assert.deepEqual(Object.keys(captured), Object.keys(golden), 'the golden covers a different call set');
});
