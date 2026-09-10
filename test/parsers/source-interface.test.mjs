// The `Source` interface (#308): every parser exposes the same scan/parse/mtime
// entry points, with `tail` only where the store is an append-only transcript.
// Each source is driven the way a caller drives it — fixture transcript
// directory in, sessions and messages out — never through parser internals.
import { test, describe, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCodeSource } from '../../server/parsers/claudeCode.ts';
import { codexSource } from '../../server/parsers/codex.ts';
import { cursorSource, clearCursorGlobalCache } from '../../server/parsers/cursor.ts';
import { opencodeSource } from '../../server/parsers/opencode.ts';
import { SOURCES, sourceById } from '../../server/parsers/registry.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const CLAUDE_FIXTURE_SESSION = path.join(FIXTURES, 'claude-code', 'fixture-session.jsonl');
const CODEX_FIXTURE_ROOT = path.join(FIXTURES, 'codex-sessions');
const CURSOR_FIXTURE_ROOT = path.join(FIXTURES, 'cursor-user');
const OPENCODE_FIXTURE_DB = path.join(FIXTURES, 'oc-live.db');

const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-source-test-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The committed Claude Code fixture sits directly under test/fixtures/claude-code,
// but a scan expects <root>/<project>/<session>.jsonl — build that layout.
function claudeFixtureRoot() {
  const root = makeTmpDir();
  const projectDir = path.join(root, '-tmp-fixture-cc');
  fs.mkdirSync(projectDir);
  fs.copyFileSync(CLAUDE_FIXTURE_SESSION, path.join(projectDir, 'fixture-session.jsonl'));
  // The session's subagents tree is a sibling folder named after the session;
  // parse folds its sidechain rows in, so the copy has to carry it.
  fs.cpSync(
    path.join(FIXTURES, 'claude-code', 'fixture-session'),
    path.join(projectDir, 'fixture-session'),
    { recursive: true },
  );
  return root;
}

describe('claude-code source', () => {
  test('scan lists the fixture project, parse turns it into sessions and messages', async () => {
    const root = claudeFixtureRoot();

    const scanned = claudeCodeSource.scan(root);
    assert.equal(scanned.length, 1);
    const [project] = scanned;
    assert.equal(project.source, 'claude-code');
    assert.equal(project.physicalPath, '/tmp/fixture-cc');
    assert.equal(project.sessionCount, 1);

    const parsed = await claudeCodeSource.parse(project);
    assert.equal(parsed.length, 1);
    const [{ session, events }] = parsed;
    assert.equal(session.id, 'fixture-session');
    assert.equal(session.source, 'claude-code');
    assert.equal(session.cwd, '/tmp/fixture-cc');
    assert.equal(session.first_prompt, 'Please explore the repo');
    assert.equal(events.length, 6);
    assert.deepEqual(
      events.map((e) => e.kind).sort(),
      ['assistant', 'assistant', 'tool_result', 'tool_use', 'user', 'user'],
    );
  });

  test('mtime folds in the session subagents tree, and is null for a path that is not there', () => {
    const root = claudeFixtureRoot();
    const file = path.join(root, '-tmp-fixture-cc', 'fixture-session.jsonl');
    const subagent = path.join(root, '-tmp-fixture-cc', 'fixture-session', 'subagents', 'agent-abc123.jsonl');
    const future = new Date('2027-01-02T03:04:05.000Z');
    fs.utimesSync(subagent, future, future);

    assert.equal(claudeCodeSource.mtime(file), future.getTime());
    assert.equal(claudeCodeSource.mtime(path.join(root, 'no-such-session.jsonl')), null);
  });

  test('tail turns one appended transcript line into events, and swallows an unparseable one', () => {
    const line = JSON.stringify({
      type: 'user', sessionId: 'fixture-session', uuid: 'u9',
      timestamp: '2026-08-01T10:02:00.000Z',
      message: { role: 'user', content: 'and now the tail' },
    });

    const events = claudeCodeSource.tail(line);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'user');
    assert.equal(events[0].text, 'and now the tail');
    assert.equal(events[0].ts, '2026-08-01T10:02:00.000Z');

    assert.deepEqual(claudeCodeSource.tail('{ not json'), []);
  });
});

describe('codex source', () => {
  test('scan lists the fixture project, parse turns it into sessions and messages', async () => {
    const scanned = codexSource.scan(CODEX_FIXTURE_ROOT);
    assert.equal(scanned.length, 1);
    const [project] = scanned;
    assert.equal(project.source, 'codex');
    assert.equal(project.physicalPath, '/Users/dev/example-repo');

    const parsed = await codexSource.parse(project);
    assert.equal(parsed.length, 1);
    const [{ session, events }] = parsed;
    assert.equal(session.id, 'codex-0197-abc');
    assert.equal(session.source, 'codex');
    assert.equal(session.cwd, '/Users/dev/example-repo');
    assert.equal(session.first_prompt, 'Add a healthcheck endpoint');
    assert.deepEqual(
      events.map((e) => e.kind),
      ['user', 'thinking', 'tool_use', 'tool_result', 'assistant'],
    );
  });

  test('parse takes a bare transcript directory, walking it for rollout files', async () => {
    const parsed = await codexSource.parse({ logDir: CODEX_FIXTURE_ROOT });
    assert.deepEqual(parsed.map((p) => p.session.id), ['codex-0197-abc']);
    assert.equal(parsed[0].events.length, 5);
  });

  test('parse attaches a token_count line\'s usage to the model output before it', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'rollout-2026-07-02T09-00-00-def.jsonl');
    fs.writeFileSync(file, [
      { timestamp: '2026-07-02T09:00:00.000Z', type: 'session_meta', payload: { id: '0198-def', cwd: '/Users/dev/example-repo' } },
      { timestamp: '2026-07-02T09:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ship it' }] } },
      { timestamp: '2026-07-02T09:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'shipped' }] } },
      { timestamp: '2026-07-02T09:00:03.000Z', type: 'token_count', payload: { info: { last_token_usage: { input_tokens: 900, output_tokens: 40, cached_input_tokens: 800, cache_write_input_tokens: 50 } } } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');

    const [{ events }] = await codexSource.parse({ logDir: dir });

    const assistant = events.find((e) => e.kind === 'assistant');
    // Codex counts the cached read inside input_tokens; the column semantics
    // split it back out, so input is 900 - 800.
    assert.equal(assistant.input_tokens, 100);
    assert.equal(assistant.output_tokens, 40);
    assert.equal(assistant.cache_read_tokens, 800);
    assert.equal(assistant.cache_w5m_tokens, 50);
    // The user turn before it is not a model output and carries no usage.
    assert.equal(events.find((e) => e.kind === 'user').input_tokens, undefined);
  });

  test('a target naming neither files nor a log dir parses nothing', async () => {
    assert.deepEqual(await codexSource.parse({}), []);
  });

  test('mtime reads the transcript file, and is null for a path that is not there', () => {
    const file = path.join(CODEX_FIXTURE_ROOT, '2026', '07', '01', 'rollout-2026-07-01T10-00-00-abc.jsonl');
    assert.equal(codexSource.mtime(file), fs.statSync(file).mtime.getTime());
    assert.equal(codexSource.mtime(path.join(CODEX_FIXTURE_ROOT, 'nope.jsonl')), null);
  });

  test('tail turns one appended rollout line into events, and swallows an unparseable one', () => {
    const line = JSON.stringify({
      timestamp: '2026-07-01T10:00:30.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'and one more' }] },
    });

    const events = codexSource.tail(line);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'assistant');
    assert.equal(events[0].text, 'and one more');
    assert.equal(events[0].ts, '2026-07-01T10:00:30.000Z');

    assert.deepEqual(codexSource.tail('{ not json'), []);
  });
});

describe('cursor source', () => {
  // Cursor resolves its user dir per platform; the fixture stands in for it,
  // and the cached global snapshot has to be dropped around each test.
  let prevCursorDir;
  let prevProjectsDir;
  beforeEach(() => {
    prevCursorDir = process.env.CHRONICLE_CURSOR_DIR;
    prevProjectsDir = process.env.CHRONICLE_CURSOR_PROJECTS_DIR;
    process.env.CHRONICLE_CURSOR_DIR = CURSOR_FIXTURE_ROOT;
    process.env.CHRONICLE_CURSOR_PROJECTS_DIR = path.join(CURSOR_FIXTURE_ROOT, 'projects');
    clearCursorGlobalCache();
  });
  afterEach(() => {
    clearCursorGlobalCache();
    if (prevCursorDir === undefined) delete process.env.CHRONICLE_CURSOR_DIR;
    else process.env.CHRONICLE_CURSOR_DIR = prevCursorDir;
    if (prevProjectsDir === undefined) delete process.env.CHRONICLE_CURSOR_PROJECTS_DIR;
    else process.env.CHRONICLE_CURSOR_PROJECTS_DIR = prevProjectsDir;
  });

  test('scan lists the fixture workspace, parse turns it into sessions and messages', async () => {
    const scanned = cursorSource.scan(CURSOR_FIXTURE_ROOT);
    assert.equal(scanned.length, 1);
    const [project] = scanned;
    assert.equal(project.source, 'cursor');
    assert.equal(project.physicalPath, '/Users/dev/example-repo');

    const parsed = await cursorSource.parse(project);
    assert.deepEqual(parsed.map((p) => p.session.id).sort(), [
      'cursor-chat-tab1',
      'cursor-composer-agent-session-1',
      'cursor-composer-comp1',
    ]);
    for (const { session, events } of parsed) {
      assert.equal(session.source, 'cursor');
      assert.equal(session.cwd, '/Users/dev/example-repo');
      assert.ok(events.length, `expected messages for ${session.id}`);
    }
    const chat = parsed.find((p) => p.session.id === 'cursor-chat-tab1');
    assert.deepEqual(chat.events.map((e) => e.kind), ['user', 'assistant']);
    assert.equal(chat.events[0].text, 'Why does login fail with OAuth?');
  });

  test('parse reads the root its target was scanned under, not this machine\'s', async () => {
    // Point the machine default somewhere empty: only the target's own root can
    // reach the global store the composer bubbles live in.
    process.env.CHRONICLE_CURSOR_DIR = makeTmpDir();
    clearCursorGlobalCache();

    const parsed = await cursorSource.parse({
      logDir: path.join(CURSOR_FIXTURE_ROOT, 'workspaceStorage', 'abc123'),
      physicalPath: '/Users/dev/example-repo',
      root: CURSOR_FIXTURE_ROOT,
    });

    const composer = parsed.find((p) => p.session.id === 'cursor-composer-comp1');
    assert.ok(composer, 'expected the composer session from the fixture root');
    assert.equal(composer.session.first_prompt, 'Refactor the dashboard to use the new chart API');
    assert.equal(composer.events.length, 5);
  });

  test('a scanned project carries its root, so scan feeds parse straight through', async () => {
    const scanned = cursorSource.scan(CURSOR_FIXTURE_ROOT);
    assert.equal(scanned[0].root, CURSOR_FIXTURE_ROOT);

    // Machine default points somewhere empty: only the stamped root reaches the
    // global store the composer bubbles live in.
    process.env.CHRONICLE_CURSOR_DIR = makeTmpDir();
    clearCursorGlobalCache();

    const parsed = await cursorSource.parse(scanned[0]);
    assert.deepEqual(parsed.map((p) => p.session.id).sort(), [
      'cursor-chat-tab1',
      'cursor-composer-agent-session-1',
      'cursor-composer-comp1',
    ]);
  });

  test('parse reads a project whose Agent transcripts were never written to disk', async () => {
    // The transcripts directory a scan names need not exist: those composers are
    // read out of the global store instead, and must not be dropped.
    const missingRoot = path.join(makeTmpDir(), 'Users-dev-example-repo', 'agent-transcripts');
    const parsed = await cursorSource.parse({
      logDir: missingRoot,
      physicalPath: '/Users/dev/example-repo',
      root: CURSOR_FIXTURE_ROOT,
    });
    assert.ok(parsed.length, 'expected the global-store composers');
  });

  test('mtime folds in the WAL sidecar a store write can land in, and is null for a path that is not there', () => {
    // A workspace whose main store is old but whose WAL was just written: the
    // sync freshness answer has to be the WAL's.
    const wsDir = path.join(makeTmpDir(), 'abc123');
    fs.mkdirSync(wsDir);
    fs.writeFileSync(path.join(wsDir, 'state.vscdb'), 'db');
    fs.writeFileSync(path.join(wsDir, 'state.vscdb-wal'), 'wal');
    const old = new Date('2026-01-01T00:00:00.000Z');
    const fresh = new Date('2026-06-01T00:00:00.000Z');
    fs.utimesSync(path.join(wsDir, 'state.vscdb'), old, old);
    fs.utimesSync(wsDir, old, old);
    fs.utimesSync(path.join(wsDir, 'state.vscdb-wal'), fresh, fresh);

    assert.equal(cursorSource.mtime(wsDir), fresh.getTime());
    assert.equal(cursorSource.mtime(path.join(CURSOR_FIXTURE_ROOT, 'workspaceStorage', 'nope')), null);
  });

  test('has no tail: a workspace store is not an append-only transcript', () => {
    assert.equal(cursorSource.tail, undefined);
  });
});

describe('opencode source', () => {
  test('scan lists the fixture store, parse turns it into sessions and messages', async () => {
    const scanned = opencodeSource.scan(OPENCODE_FIXTURE_DB);
    assert.equal(scanned.length, 1);
    const [project] = scanned;
    assert.equal(project.source, 'opencode');
    assert.equal(project.physicalPath, '/tmp/oc-live-project');

    const parsed = await opencodeSource.parse(project);
    assert.equal(parsed.length, 1);
    const [{ session, events }] = parsed;
    assert.equal(session.id, 'oc-ses_live1');
    assert.equal(session.source, 'opencode');
    assert.equal(session.cwd, '/tmp/oc-live-project');
    assert.equal(session.first_prompt, 'initial message');
    assert.deepEqual(events.map((e) => e.kind), ['user', 'assistant', 'tool_use', 'tool_result']);
  });

  test('parse takes the bare store, covering every directory it holds', async () => {
    const parsed = await opencodeSource.parse({ logDir: OPENCODE_FIXTURE_DB });
    assert.deepEqual(parsed.map((p) => p.session.id), ['oc-ses_live1']);
  });

  test('parse never touches the source store', async () => {
    const before = fs.statSync(OPENCODE_FIXTURE_DB);
    await opencodeSource.parse({ logDir: OPENCODE_FIXTURE_DB, directory: '/tmp/oc-live-project' });
    const after = fs.statSync(OPENCODE_FIXTURE_DB);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  });

  test('mtime reads the store, and is null for a path that is not there', () => {
    assert.equal(opencodeSource.mtime(OPENCODE_FIXTURE_DB), fs.statSync(OPENCODE_FIXTURE_DB).mtime.getTime());
    assert.equal(opencodeSource.mtime(path.join(FIXTURES, 'no-such.db')), null);
  });

  test('has no tail: a SQLite store is not an append-only transcript', () => {
    assert.equal(opencodeSource.tail, undefined);
  });
});

describe('the four sources together', () => {
  test('the registry holds one source per coding tool, each answering to its own id', () => {
    assert.deepEqual(SOURCES.map((s) => s.id).sort(), ['claude-code', 'codex', 'cursor', 'opencode']);
    for (const source of [claudeCodeSource, codexSource, cursorSource, opencodeSource]) {
      assert.equal(sourceById(source.id), source);
    }
    // A tool with no parser has no source, rather than a stub that scans nothing.
    assert.equal(sourceById('gemini'), undefined);
  });

  test('tail is there for the append-only transcripts and absent for the SQLite stores', () => {
    assert.deepEqual(
      SOURCES.filter((s) => s.tail).map((s) => s.id).sort(),
      ['claude-code', 'codex'],
    );
  });

  test('scan and parse agree on a root that holds nothing: no sessions, no throw', async () => {
    const missing = path.join(makeTmpDir(), 'not-here');
    for (const source of SOURCES) {
      assert.deepEqual(source.scan(missing), [], `${source.id} scan`);
      assert.deepEqual(await source.parse({ logDir: missing }), [], `${source.id} parse`);
      assert.equal(source.mtime(missing), null, `${source.id} mtime`);
      assert.ok(source.defaultRoot().length, `${source.id} defaultRoot`);
    }
  });
});
