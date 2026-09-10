import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexSource } from '../../server/parsers/codex.ts';

// Through the `Source` interface, the one way in (#309).
const parseCodexSession = async (file) => (await codexSource.parse({ files: [file] }))[0];
const scanCodexProjects = (dir) => codexSource.scan(dir);

const FIXTURE_BASE = 'test/fixtures/codex-sessions';
const FIXTURE_FILE = path.join(
  FIXTURE_BASE,
  '2026',
  '07',
  '01',
  'rollout-2026-07-01T10-00-00-abc.jsonl',
);

test('scanCodexProjects: finds the fixture session, grouped by sniffed cwd', () => {
  const projects = scanCodexProjects(FIXTURE_BASE);
  assert.equal(projects.length, 1);

  const [project] = projects;
  assert.equal(project.source, 'codex');
  assert.equal(project.physicalPath, '/Users/dev/example-repo');
  assert.equal(project.name, 'example-repo');
  assert.equal(project.sessionCount, 1);
  assert.equal(project.files.length, 1);
  assert.equal(project.files[0], FIXTURE_FILE);

  const [session] = project.sessions;
  assert.equal(session.id, 'rollout-2026-07-01T10-00-00-abc');
  assert.equal(session.file, FIXTURE_FILE);
});

test('parseCodexSession: session envelope pins id, cwd, timestamps, first prompt', async () => {
  const { session } = await parseCodexSession(FIXTURE_FILE);

  // Session id is "codex-" + the session_meta payload's own id (NOT the filename).
  assert.equal(session.id, 'codex-0197-abc');
  assert.equal(session.source, 'codex');
  assert.equal(session.file_path, FIXTURE_FILE);
  assert.equal(session.cwd, '/Users/dev/example-repo');
  assert.equal(session.first_prompt, 'Add a healthcheck endpoint');
  assert.equal(session.skipped, 0);
  assert.equal(session.started_at, '2026-07-01T10:00:05.000Z');
  assert.equal(session.ended_at, '2026-07-01T10:00:20.000Z');
  assert.ok(new Date(session.started_at).getTime() <= new Date(session.ended_at).getTime());
});

test('parseCodexSession: maps rollout event types to the normalized kind set, in order', async () => {
  const { events } = await parseCodexSession(FIXTURE_FILE);

  assert.equal(events.length, 5);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['user', 'thinking', 'tool_use', 'tool_result', 'assistant'],
  );

  const [userEvt, thinkingEvt, toolUseEvt, toolResultEvt, assistantEvt] = events;

  assert.equal(userEvt.text, 'Add a healthcheck endpoint');
  assert.equal(
    thinkingEvt.text,
    'User wants a healthcheck route; check framework first.',
  );
  assert.equal(assistantEvt.text, 'Added GET /api/health returning 200.');

  // function_call -> tool_use: tool_name falls back to payload.name, tool_input
  // is the raw (still-JSON-encoded) `arguments` string as Codex wrote it.
  assert.equal(toolUseEvt.tool_name, 'shell');
  assert.equal(toolUseEvt.tool_input, '{"command":["ls","src/app"]}');
  assert.equal(toolUseEvt.tool_use_id, 'call_1');

  // function_call_output -> tool_result, paired via the same call_id.
  assert.equal(toolResultEvt.tool_use_id, toolUseEvt.tool_use_id);
  assert.equal(
    toolResultEvt.text,
    '{"output":"api\\ndashboard\\n","metadata":{"exit_code":0}}',
  );
});

test('parseCodexSession: per-event token usage fields are absent when the fixture has no token_count event', async () => {
  const { events } = await parseCodexSession(FIXTURE_FILE);

  // The fixture never emits a `token_count` rollout event, so the parser's
  // usage-attachment branch (codex.js ~line 83-98) never runs. Pinning the
  // absence here documents that this fixture does NOT exercise per-message
  // token aggregation (input_tokens/output_tokens/cache_read_tokens/
  // cache_w5m_tokens) — see report-codex.md.
  for (const e of events) {
    assert.equal(e.input_tokens, undefined);
    assert.equal(e.output_tokens, undefined);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Model capture (#198). Codex records the model it ran a turn on in the
// rollout's own context lines, not on the response items — so these fixtures
// are written per test rather than added to the committed one.

const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-codex-test-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeRollout(lines) {
  const dir = makeTmpDir();
  const file = path.join(dir, 'rollout-2026-07-02T09-00-00-def.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const META = { timestamp: '2026-07-02T09:00:00.000Z', type: 'session_meta', payload: { id: '0198-def', cwd: '/Users/dev/example-repo' } };
const TURN_CONTEXT = (model, at) => ({ timestamp: at, type: 'turn_context', payload: { cwd: '/Users/dev/example-repo', model, effort: 'medium' } });
const USER = (text, at) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const ASSISTANT = (text, at) => ({ timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });

test('parseCodexSession: the turn context model lands on every model output of the turn', async () => {
  const file = writeRollout([
    META,
    TURN_CONTEXT('gpt-5-codex', '2026-07-02T09:00:01.000Z'),
    USER('ship it', '2026-07-02T09:00:02.000Z'),
    { timestamp: '2026-07-02T09:00:03.000Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] } },
    { timestamp: '2026-07-02T09:00:04.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' } },
    ASSISTANT('shipped', '2026-07-02T09:00:05.000Z'),
  ]);

  const { events } = await parseCodexSession(file);
  const modelOf = (kind) => events.find((e) => e.kind === kind).model;

  assert.equal(modelOf('assistant'), 'gpt-5-codex');
  assert.equal(modelOf('thinking'), 'gpt-5-codex');
  assert.equal(modelOf('tool_use'), 'gpt-5-codex');
  // A user turn is the operator's, not the model's — it carries no model.
  assert.equal(modelOf('user'), undefined);
});
