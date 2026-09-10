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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const CLAUDE_FIXTURE_SESSION = path.join(FIXTURES, 'claude-code', 'fixture-session.jsonl');

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
