import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cursorProjectSlug,
  clearCursorGlobalCache,
  parseAgentTranscriptJsonl,
  parseCursorAgentSessions,
  scanCursorProjects,
  parseCursorWorkspace,
} from '../../server/parsers/cursor.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/cursor-user', import.meta.url));
const PROJECT_PATH = '/Users/dev/example-repo';
const WORKSPACE_DB = path.join(FIXTURE_ROOT, 'workspaceStorage', 'abc123', 'state.vscdb');
const GLOBAL_DB = path.join(FIXTURE_ROOT, 'globalStorage', 'state.vscdb');
const AGENT_TRANSCRIPT = path.join(
  FIXTURE_ROOT, 'projects', 'Users-dev-example-repo', 'agent-transcripts',
  'agent-session-1', 'agent-session-1.jsonl',
);

// Same (buggy) local-timezone parse the parser's extractTimestamp() performs on
// the <timestamp>…(UTC)</timestamp> tag: `new Date(str)` ignores the literal
// "(UTC)" annotation and interprets the string in the machine's local timezone.
// Computing the expectation the same way keeps this test TZ-portable while still
// pinning the exact current (buggy) value on whatever machine runs it — see
// "## Bugs found" in the report.
const AGENT_EXPECTED_TS = new Date('Wednesday, Jul 1, 2026, 8:05 AM (UTC)').toISOString();

let prevCursorDir;
let prevProjectsDir;

beforeEach(() => {
  prevCursorDir = process.env.CHRONICLE_CURSOR_DIR;
  prevProjectsDir = process.env.CHRONICLE_CURSOR_PROJECTS_DIR;
  process.env.CHRONICLE_CURSOR_DIR = FIXTURE_ROOT;
  process.env.CHRONICLE_CURSOR_PROJECTS_DIR = path.join(FIXTURE_ROOT, 'projects');
  clearCursorGlobalCache();
});

afterEach(() => {
  clearCursorGlobalCache();
  if (prevCursorDir === undefined) delete process.env.CHRONICLE_CURSOR_DIR;
  else process.env.CHRONICLE_CURSOR_DIR = prevCursorDir;
  if (prevProjectsDir === undefined) delete process.env.CHRONICLE_CURSOR_PROJECTS_DIR;
  else process.env.CHRONICLE_CURSOR_PROJECTS_DIR = prevProjectsDir;
});

test('cursorProjectSlug: strips leading slash, maps separators and underscores to dashes', () => {
  assert.equal(cursorProjectSlug('/Users/dev/example-repo'), 'Users-dev-example-repo');
  // Round-trips against the fixture's on-disk agent-transcripts folder name.
  assert.equal(cursorProjectSlug(PROJECT_PATH), 'Users-dev-example-repo');
  // Underscores AND path separators both become dashes — a path containing an
  // underscore is indistinguishable from one with an extra path segment.
  assert.equal(cursorProjectSlug('/Users/dev_test/my_repo'), 'Users-dev-test-my-repo');
});

test('clearCursorGlobalCache: safe to call with no cache present, and idempotent', () => {
  clearCursorGlobalCache();
  assert.doesNotThrow(() => clearCursorGlobalCache());
});

test('scanCursorProjects: finds exactly one project, aggregating chat/composer/agent sessions', () => {
  const beforeWs = fs.statSync(WORKSPACE_DB);
  const beforeGlobal = fs.statSync(GLOBAL_DB);

  const scanned = scanCursorProjects(FIXTURE_ROOT);

  const afterWs = fs.statSync(WORKSPACE_DB);
  const afterGlobal = fs.statSync(GLOBAL_DB);
  assert.equal(afterWs.mtimeMs, beforeWs.mtimeMs, 'scan must not touch the workspace DB mtime');
  assert.equal(afterWs.size, beforeWs.size, 'scan must not touch the workspace DB size');
  assert.equal(afterGlobal.mtimeMs, beforeGlobal.mtimeMs, 'scan must not touch the global DB mtime');
  assert.equal(afterGlobal.size, beforeGlobal.size, 'scan must not touch the global DB size');

  assert.equal(scanned.length, 1);
  const [row] = scanned;
  assert.equal(row.source, 'cursor');
  assert.equal(row.logDir, path.join(FIXTURE_ROOT, 'workspaceStorage', 'abc123'));
  assert.equal(row.name, 'example-repo');
  assert.equal(row.physicalPath, PROJECT_PATH);
  // 1 legacy chat tab + 1 legacy composer + 1 agent-transcript session.
  assert.equal(row.sessionCount, 3);
  // 2 bubbles (chat tab) + 2 headers-only composer (fullConversationHeadersOnly)
  // + 2 agent-transcript JSONL lines.
  assert.equal(row.messageEstimate, 6);
});

test('parseCursorWorkspace: yields the 3 fixture sessions with expected ids and cwd', () => {
  const scanned = scanCursorProjects(FIXTURE_ROOT);
  const [row] = scanned;

  const parsed = parseCursorWorkspace(row.logDir, FIXTURE_ROOT, PROJECT_PATH);
  const ids = parsed.map((p) => p.session.id).sort();
  assert.deepEqual(ids, [
    'cursor-chat-tab1',
    'cursor-composer-agent-session-1',
    'cursor-composer-comp1',
  ]);
  for (const p of parsed) {
    assert.equal(p.session.source, 'cursor');
    assert.equal(p.session.cwd, PROJECT_PATH);
    assert.equal(p.session.skipped, 0);
  }
});

test('parseCursorWorkspace: legacy chat tab pins exact user/assistant events and timestamps', () => {
  const parsed = parseCursorWorkspace(
    path.join(FIXTURE_ROOT, 'workspaceStorage', 'abc123'), FIXTURE_ROOT, PROJECT_PATH,
  );
  const tab = parsed.find((p) => p.session.id === 'cursor-chat-tab1');
  assert.ok(tab, 'expected cursor-chat-tab1 session');

  assert.equal(tab.session.file_path, path.join(FIXTURE_ROOT, 'workspaceStorage', 'abc123', 'state.vscdb'));
  assert.equal(tab.session.first_prompt, 'Why does login fail with OAuth?');
  assert.equal(tab.session.started_at, '2026-07-01T08:00:00.000Z');
  assert.equal(tab.session.ended_at, '2026-07-01T08:00:05.000Z');

  assert.equal(tab.events.length, 2);
  assert.deepEqual(tab.events.map((e) => e.kind), ['user', 'assistant']);
  assert.equal(tab.events[0].text, 'Why does login fail with OAuth?');
  assert.equal(tab.events[0].ts, '2026-07-01T08:00:00.000Z');
  assert.equal(tab.events[1].text, 'The redirect URI is mismatched.');
  assert.equal(tab.events[1].model, 'gpt-4');
  assert.equal(tab.events[1].ts, '2026-07-01T08:00:05.000Z');
});

test('parseCursorWorkspace: legacy composer expands thinking + tool_use/tool_result pair via tool_use_id', () => {
  const parsed = parseCursorWorkspace(
    path.join(FIXTURE_ROOT, 'workspaceStorage', 'abc123'), FIXTURE_ROOT, PROJECT_PATH,
  );
  const comp = parsed.find((p) => p.session.id === 'cursor-composer-comp1');
  assert.ok(comp, 'expected cursor-composer-comp1 session');

  assert.equal(comp.session.first_prompt, 'Refactor the dashboard to use the new chart API');
  assert.equal(comp.events.length, 5);
  assert.deepEqual(
    comp.events.map((e) => e.kind),
    ['user', 'assistant', 'thinking', 'tool_use', 'tool_result'],
  );

  const [userEvt, assistantEvt, thinkingEvt, toolUseEvt, toolResultEvt] = comp.events;
  assert.equal(userEvt.text, 'Refactor the dashboard to use the new chart API');
  assert.equal(assistantEvt.text, 'Done — replaced Recharts wrappers.');
  assert.equal(thinkingEvt.text, 'Need to check chart imports first');

  assert.equal(toolUseEvt.tool_name, 'read_file');
  assert.equal(toolUseEvt.tool_input, JSON.stringify({ path: 'src/app/dashboard/page.tsx' }));
  assert.equal(toolUseEvt.tool_use_id, 'tc1');

  // tool_result pairs with tool_use via the shared tool_use_id.
  assert.equal(toolResultEvt.tool_use_id, toolUseEvt.tool_use_id);
  assert.equal(toolResultEvt.text, 'export default ...');
});

test('parseAgentTranscriptJsonl: strips the <timestamp>/<user_query> envelope and propagates the tagged ts to the assistant turn', () => {
  const before = fs.statSync(AGENT_TRANSCRIPT);

  const direct = parseAgentTranscriptJsonl(AGENT_TRANSCRIPT);

  const after = fs.statSync(AGENT_TRANSCRIPT);
  assert.equal(after.mtimeMs, before.mtimeMs, 'parse must not touch the transcript file mtime');
  assert.equal(after.size, before.size, 'parse must not touch the transcript file size');

  assert.equal(direct.length, 2);
  assert.deepEqual(direct.map((e) => e.kind), ['user', 'assistant']);
  assert.equal(direct[0].text, 'Add agent transcript import');
  assert.equal(direct[1].text, 'Implemented agent transcript parsing.');

  // Both events carry the same ts: the user turn's <timestamp> tag is parsed
  // and reused as `turnTs` for the following assistant turn (which has no tag
  // of its own).
  assert.equal(direct[0].ts, AGENT_EXPECTED_TS);
  assert.equal(direct[1].ts, AGENT_EXPECTED_TS);
});

test('parseCursorAgentSessions: agent-transcript composer session matches the direct transcript parse', () => {
  const sessions = parseCursorAgentSessions(PROJECT_PATH, FIXTURE_ROOT);
  assert.equal(sessions.length, 1);
  const [s] = sessions;

  assert.equal(s.session.id, 'cursor-composer-agent-session-1');
  assert.equal(s.session.cwd, PROJECT_PATH);
  assert.equal(s.session.file_path, AGENT_TRANSCRIPT);
  // makeSession() prefers the first user event's text over the composer
  // header's `name` ("Agent mode export test") for first_prompt.
  assert.equal(s.session.first_prompt, 'Add agent transcript import');
  assert.equal(s.session.started_at, AGENT_EXPECTED_TS);
  assert.equal(s.session.ended_at, AGENT_EXPECTED_TS);
  assert.equal(s.events.length, 2);
});

test('scanCursorProjects + parseCursorWorkspace: union of kinds across the fixture is exactly the 5 normalized kinds', () => {
  const scanned = scanCursorProjects(FIXTURE_ROOT);
  const parsed = parseCursorWorkspace(scanned[0].logDir, FIXTURE_ROOT, PROJECT_PATH);
  const kinds = new Set();
  for (const p of parsed) for (const e of p.events) kinds.add(e.kind);
  assert.deepEqual(
    [...kinds].sort(),
    ['assistant', 'thinking', 'tool_result', 'tool_use', 'user'],
  );
});

test('read-only guarantee: WAL/SHM sidecars next to the workspace DB are copied, not opened in place', () => {
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-cursor-test-'));
  try {
    fs.cpSync(FIXTURE_ROOT, tmpUserDir, { recursive: true });
    const tmpWsDb = path.join(tmpUserDir, 'workspaceStorage', 'abc123', 'state.vscdb');
    const walPath = `${tmpWsDb}-wal`;
    const shmPath = `${tmpWsDb}-shm`;
    fs.writeFileSync(walPath, Buffer.from('fake-wal-sidecar-for-copy-test'));
    fs.writeFileSync(shmPath, Buffer.from('fake-shm-sidecar-for-copy-test'));

    const beforeDb = fs.statSync(tmpWsDb);
    const beforeWal = fs.statSync(walPath);
    const beforeShm = fs.statSync(shmPath);

    process.env.CHRONICLE_CURSOR_DIR = tmpUserDir;
    process.env.CHRONICLE_CURSOR_PROJECTS_DIR = path.join(tmpUserDir, 'projects');
    clearCursorGlobalCache();

    const scanned = scanCursorProjects(tmpUserDir);
    // Same session/message counts as the untouched fixture: the presence of
    // (garbage) -wal/-shm sidecars didn't break parsing, meaning the parser
    // operated on a copy rather than choking on / mutating the originals.
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].sessionCount, 3);
    const parsed = parseCursorWorkspace(scanned[0].logDir, tmpUserDir, PROJECT_PATH);
    assert.equal(parsed.length, 3);

    const afterDb = fs.statSync(tmpWsDb);
    const afterWal = fs.statSync(walPath);
    const afterShm = fs.statSync(shmPath);
    assert.equal(afterDb.mtimeMs, beforeDb.mtimeMs, 'main db sidecar-adjacent mtime must be untouched');
    assert.equal(afterDb.size, beforeDb.size, 'main db size must be untouched');
    assert.equal(afterWal.mtimeMs, beforeWal.mtimeMs, '-wal sidecar mtime must be untouched (parser must copy, not open in place)');
    assert.equal(afterWal.size, beforeWal.size, '-wal sidecar size must be untouched');
    assert.equal(afterShm.mtimeMs, beforeShm.mtimeMs, '-shm sidecar mtime must be untouched');
    assert.equal(afterShm.size, beforeShm.size, '-shm sidecar size must be untouched');
  } finally {
    fs.rmSync(tmpUserDir, { recursive: true, force: true });
  }
});
