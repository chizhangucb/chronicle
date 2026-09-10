// The `Source` interface (#308): every parser exposes the same scan/parse/mtime
// entry points, with `tail` only where the store is an append-only transcript.
// Each source is driven the way a caller drives it — fixture transcript
// directory in, sessions and messages out — never through parser internals.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCodeSource } from '../../server/parsers/claudeCode.ts';
import { codexSource } from '../../server/parsers/codex.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const CLAUDE_FIXTURE_SESSION = path.join(FIXTURES, 'claude-code', 'fixture-session.jsonl');
const CODEX_FIXTURE_ROOT = path.join(FIXTURES, 'codex-sessions');

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
