// Characterization tests for server/parsers/claudeCode.js.
// These pin CURRENT observed behavior against the committed fixtures (and, where the
// committed fixtures don't exercise a documented behavior, small temp-file fixtures
// built at test time). They intentionally do NOT fix any bugs found — see the report
// at .superpowers/sdd/2026-08-09-chronicle-reramp-phase3/report-claudeCode.md.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLAUDE_PROJECTS_DIR,
  scanClaudeProjects,
  parseClaudeLine,
  parseClaudeSession,
} from '../../server/parsers/claudeCode.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'claude-code');
const FIXTURE_SESSION = path.join(FIXTURE_DIR, 'fixture-session.jsonl');

// Temp dirs created by tests that need fixtures the committed ones don't provide
// (multi-cwd sessions, malformed lines, a realistic scan layout). Cleaned up after.
const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-cc-test-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('CLAUDE_PROJECTS_DIR', () => {
  test('points at ~/.claude/projects', () => {
    assert.equal(CLAUDE_PROJECTS_DIR, path.join(os.homedir(), '.claude', 'projects'));
  });
});

describe('scanClaudeProjects', () => {
  test('on the committed fixture dir finds nothing — files sit directly under the dir, not inside a project subdir', () => {
    // scanClaudeProjects expects <baseDir>/<project>/<session>.jsonl. The committed
    // fixture has fixture-session.jsonl directly under test/fixtures/claude-code, and
    // the fixture-session/ directory only holds subagents/ (no .jsonl directly in it),
    // so neither is picked up. Pinning this actual (surprising) result.
    const result = scanClaudeProjects(FIXTURE_DIR);
    assert.deepEqual(result, []);
  });

  test('on a nonexistent dir returns []', () => {
    assert.deepEqual(scanClaudeProjects(path.join(FIXTURE_DIR, 'does-not-exist')), []);
  });

  test('on a realistic <baseDir>/<project>/<session>.jsonl layout resolves session count and cwd', () => {
    const base = makeTmpDir();
    const projectDir = path.join(base, 'project-hash-1');
    fs.mkdirSync(projectDir);
    // Two session files, one project.
    fs.writeFileSync(path.join(projectDir, 'session-a.jsonl'), fs.readFileSync(FIXTURE_SESSION));
    fs.writeFileSync(
      path.join(projectDir, 'session-b.jsonl'),
      '{"type":"user","cwd":"/tmp/fixture-cc","uuid":"x1","timestamp":"2026-08-01T11:00:00.000Z","message":{"role":"user","content":"hi"}}\n'
    );
    const result = scanClaudeProjects(base);
    assert.equal(result.length, 1);
    const proj = result[0];
    assert.equal(proj.source, 'claude-code');
    assert.equal(proj.sessionCount, 2);
    assert.equal(proj.physicalPath, '/tmp/fixture-cc');
    assert.equal(proj.name, 'fixture-cc'); // basename of the resolved physicalPath
    assert.equal(proj.sessions.length, 2);
    const ids = proj.sessions.map((s) => s.id).sort();
    assert.deepEqual(ids, ['session-a', 'session-b']);
  });
});

describe('parseClaudeSession — fixture-session.jsonl', () => {
  test('resolves session id, cwd, and prompt/summary fields', async () => {
    const { session } = await parseClaudeSession(FIXTURE_SESSION);
    assert.equal(session.id, 'fixture-session');
    assert.equal(session.source, 'claude-code');
    assert.equal(session.cwd, '/tmp/fixture-cc');
    assert.equal(session.first_prompt, 'Please explore the repo');
    // No custom-title or legacy summary line in this fixture.
    assert.equal(session.summary, null);
    assert.equal(session.skipped, 0);
  });

  test('first_prompt skips a leading cross-session / command-echo message (CHI-368)', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'ipc-first.jsonl');
    const lines = [
      // a cross-session IPC message logs as role=user but is NOT a human prompt
      { type: 'user', cwd: '/tmp/x', uuid: 'u1', timestamp: '2026-08-01T10:00:00.000Z',
        message: { role: 'user', content: 'Another Claude session sent a message:\n<cross-session-message from="x">handoff</cross-session-message>' } },
      // the real human prompt comes next — this is what the display name should use
      { type: 'user', cwd: '/tmp/x', uuid: 'u2', timestamp: '2026-08-01T10:01:00.000Z',
        message: { role: 'user', content: 'actually fix the flaky test' } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { session } = await parseClaudeSession(file);
    assert.equal(session.first_prompt, 'actually fix the flaky test');
  });

  test('started_at / ended_at are sane and bracket the events', async () => {
    const { session } = await parseClaudeSession(FIXTURE_SESSION);
    assert.equal(session.started_at, '2026-08-01T10:00:00.000Z');
    assert.equal(session.ended_at, '2026-08-01T10:01:10.000Z');
    assert.ok(Date.parse(session.started_at) <= Date.parse(session.ended_at));
  });

  test('yields 6 events (4 main chain + 2 sidechain) across all five kinds except thinking/tool_result-only gaps', async () => {
    const { events } = await parseClaudeSession(FIXTURE_SESSION);
    assert.equal(events.length, 6);
    const kinds = events.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['assistant', 'assistant', 'tool_result', 'tool_use', 'user', 'user']);
  });

  test('tool_use/tool_result pairing shares tool_use_id "t1"', async () => {
    const { events } = await parseClaudeSession(FIXTURE_SESSION);
    const use = events.find((e) => e.kind === 'tool_use');
    const result = events.find((e) => e.kind === 'tool_result');
    assert.equal(use.tool_use_id, 't1');
    assert.equal(result.tool_use_id, 't1');
    assert.equal(use.tool_name, 'Task');
    assert.equal(result.text, 'done');
  });

  test('sidechain events (from subagents/agent-abc123.jsonl) are flagged is_sidechain and get agent_type "Explore" via Task prompt pairing', async () => {
    const { events } = await parseClaudeSession(FIXTURE_SESSION);
    const sidechainEvents = events.filter((e) => e.is_sidechain === 1);
    assert.equal(sidechainEvents.length, 2);
    for (const e of sidechainEvents) assert.equal(e.agent_type, 'Explore');
    assert.equal(sidechainEvents[0].text, 'Survey the repo layout');
    assert.equal(sidechainEvents[1].text, 'One module: src/.');
  });

  test('main-chain events are NOT flagged is_sidechain', async () => {
    const { events } = await parseClaudeSession(FIXTURE_SESSION);
    const mainChain = events.filter((e) => e.tool_use_id === 't1' || e.text === 'Please explore the repo' || e.text === 'The repo has one module.');
    for (const e of mainChain) assert.equal(e.is_sidechain, undefined);
  });

  test('per-model usage aggregation splits 5m/1h cache tiers and includes sidechain spend', async () => {
    const { session } = await parseClaudeSession(FIXTURE_SESSION);
    const usage = JSON.parse(session.usage);
    assert.deepEqual(Object.keys(usage), ['claude-fable-5']);
    const u = usage['claude-fable-5'];
    // input: 100 (a1) + 120 (a2) + 80 (sidechain s2) = 300
    assert.equal(u.input, 300);
    // output: 50 + 30 + 40 = 120
    assert.equal(u.output, 120);
    // cacheRead: 1000 + 1200 + 500 = 2700
    assert.equal(u.cacheRead, 2700);
    // cacheWrite5m: a1 explicit ephemeral_5m=200 + a2 legacy cache_creation_input_tokens=50
    //   (no cache_creation object -> falls into the 5m bucket) + sidechain legacy 10 = 260
    assert.equal(u.cacheWrite5m, 260);
    // cacheWrite1h: only a1 explicitly set ephemeral_1h=0
    assert.equal(u.cacheWrite1h, 0);
  });

  test('context_tokens is computed from the LAST main-chain assistant usage only (sidechain excluded)', async () => {
    const { session } = await parseClaudeSession(FIXTURE_SESSION);
    // a2 (main chain, last with usage): input 120 + cache_creation_input_tokens 50 + cache_read 1200 = 1370
    assert.equal(session.context_tokens, 1370);
  });

  test('per-event usage is attached to the first event of the owning assistant line', async () => {
    const { events } = await parseClaudeSession(FIXTURE_SESSION);
    const toolUse = events.find((e) => e.tool_name === 'Task');
    assert.equal(toolUse.input_tokens, 100);
    assert.equal(toolUse.output_tokens, 50);
    assert.equal(toolUse.cache_read_tokens, 1000);
    assert.equal(toolUse.cache_w5m_tokens, 200);
    assert.equal(toolUse.cache_w1h_tokens, 0);
  });
});

describe('parseClaudeSession — synthetic fixtures for behavior the committed fixture does not exercise', () => {
  test('custom-title: LAST {"type":"custom-title",...} line wins over an earlier one and over a legacy summary', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'custom-title-session.jsonl');
    const lines = [
      { type: 'summary', summary: 'Legacy summary title' },
      { type: 'user', sessionId: 's', cwd: '/tmp/x', uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
      { type: 'custom-title', customTitle: 'First rename' },
      { type: 'custom-title', customTitle: 'Second rename (final)' },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { session } = await parseClaudeSession(file);
    assert.equal(session.summary, 'Second rename (final)');
  });

  // ── CHI-286 regression pins ────────────────────────────────────────────────
  // Claude Code splits ONE API response's content blocks across several
  // transcript lines, each repeating the FULL `message.usage` and the same
  // `message.id`/`requestId`. Summing per line billed one call 2-3 times (the
  // Insights Spend tile ran 2.2-2.4x hot). These pin the collapse.

  test('CHI-286: one API call split across empty-thinking / text / tool_use lines is billed ONCE', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'split-call-session.jsonl');
    const usage = (out) => ({
      input_tokens: 10, output_tokens: out, cache_read_input_tokens: 5000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 700 },
    });
    // The REAL observed shape: the call opens with a `thinking` block that is
    // empty, which parseClaudeLine drops entirely — 58.8% of calls on disk look
    // like this, so the "a later line claims the slot" path is the dominant one,
    // not an edge case. The third line is TRUNCATED (output 40 < 900), which is
    // why the rule is keep-MAX rather than first- or last-wins.
    const lines = [
      { type: 'user', sessionId: 's', cwd: '/tmp/x', uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 's', uuid: 'a1', requestId: 'req_1', timestamp: '2026-08-01T00:00:01.000Z',
        message: { id: 'msg_1', model: 'claude-fable-5', content: [{ type: 'thinking', thinking: '' }], usage: usage(900) } },
      { type: 'assistant', sessionId: 's', uuid: 'a2', requestId: 'req_1', timestamp: '2026-08-01T00:00:02.000Z',
        message: { id: 'msg_1', model: 'claude-fable-5', content: [{ type: 'text', text: 'answer' }], usage: usage(900) } },
      { type: 'assistant', sessionId: 's', uuid: 'a3', requestId: 'req_1', timestamp: '2026-08-01T00:00:03.000Z',
        message: { id: 'msg_1', model: 'claude-fable-5', content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: {} }], usage: usage(40) } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { session, events } = await parseClaudeSession(file);

    // Billed once, not three times, and at the LARGEST cell seen.
    assert.deepEqual(JSON.parse(session.usage), {
      'claude-fable-5': { input: 10, output: 900, cacheWrite5m: 0, cacheWrite1h: 700, cacheRead: 5000 },
    });
    // The empty-thinking line produced no event, so the TEXT event owns the
    // tokens — the first event-producing line of the call, not the first line.
    const carrying = events.filter((e) => e.input_tokens != null);
    assert.equal(carrying.length, 1);
    assert.equal(carrying[0].kind, 'assistant');
    assert.equal(carrying[0].text, 'answer');
    assert.equal(carrying[0].output_tokens, 900);
    // Every other event of the call is NULL, so summing never double-counts.
    for (const e of events) {
      if (e === carrying[0]) continue;
      assert.equal(e.input_tokens ?? null, null);
    }
  });

  test('CHI-286: the call key is stamped on every assistant event, usage-bearing or not', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'key-stamp-session.jsonl');
    const lines = [
      { type: 'user', sessionId: 's', cwd: '/tmp/x', uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'go' } },
      { type: 'assistant', sessionId: 's', uuid: 'a1', requestId: 'req_9', timestamp: '2026-08-01T00:00:01.000Z',
        message: { id: 'msg_9', model: 'm', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash', id: 't1', input: {} }],
                   usage: { input_tokens: 1, output_tokens: 2 } } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { events } = await parseClaudeSession(file);
    const assistantEvents = events.filter((e) => e.kind !== 'user');
    assert.equal(assistantEvents.length, 2);
    // Both events of the line carry the key (only the first carries tokens), so
    // contract_message_metrics readers can dedup or audit.
    for (const e of assistantEvents) {
      assert.equal(e.message_id, 'msg_9');
      assert.equal(e.request_id, 'req_9');
    }
    assert.equal(events.find((e) => e.kind === 'user').message_id ?? null, null);
  });

  test('CHI-286: a line carrying neither message.id nor requestId is never collapsed', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'unkeyed-session.jsonl');
    // Two identical-usage lines with no ids at all. They cannot be PROVEN
    // replays, so each is billed on its own (matches Varde's `if (msgId ||
    // reqId)` guard) — the fix must not silently swallow real spend.
    const l = (uuid, ts) => ({ type: 'assistant', sessionId: 's', cwd: '/tmp/x', uuid, timestamp: ts,
      message: { model: 'm', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 7, output_tokens: 3 } } });
    fs.writeFileSync(file, [JSON.stringify(l('a1', '2026-08-01T00:00:01.000Z')), JSON.stringify(l('a2', '2026-08-01T00:00:02.000Z'))].join('\n') + '\n');
    const { session } = await parseClaudeSession(file);
    assert.deepEqual(JSON.parse(session.usage), {
      m: { input: 14, output: 6, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    });
  });

  test('CHI-286 invariant: SUM(event token cells) === sessions.usage', async () => {
    const { session, events } = await parseClaudeSession(FIXTURE_SESSION);
    const sum = {};
    for (const e of events) {
      if (e.input_tokens == null) continue;
      const m = e.model || 'unknown';
      sum[m] ??= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
      sum[m].input += e.input_tokens;
      sum[m].output += e.output_tokens;
      sum[m].cacheWrite5m += e.cache_w5m_tokens;
      sum[m].cacheWrite1h += e.cache_w1h_tokens;
      sum[m].cacheRead += e.cache_read_tokens;
    }
    // Every billed token sits on exactly ONE message row. Before CHI-286 the
    // two sides disagreed by 25.2% system-wide: an assistant line whose only
    // content was an empty `thinking` block reached the session total but
    // produced no event to hang its tokens on, while replayed lines that DID
    // produce events were counted repeatedly.
    //
    // Equality holds whenever every call produced at least one event, which is
    // the case for this fixture and for 407 of 420 real sessions measured. The
    // residual 13 are calls whose only content was an empty thinking block, so
    // no row exists to hold their cells; the parser still bills them (real
    // spend beats a tidy invariant), which makes the general rule
    // SUM(messages) <= sessions.usage — 0.0286% of tokens in practice.
    assert.deepEqual(sum, JSON.parse(session.usage));
  });

  test('malformed JSON lines are counted in `skipped` and do not throw or produce events', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'malformed-session.jsonl');
    const good1 = JSON.stringify({ type: 'user', sessionId: 's', cwd: '/tmp/x', uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } });
    const good2 = JSON.stringify({ type: 'assistant', sessionId: 's', uuid: 'a1', timestamp: '2026-08-01T00:00:01.000Z', message: { model: 'm', content: [{ type: 'text', text: 'world' }] } });
    fs.writeFileSync(file, [good1, '{not valid json', good2].join('\n') + '\n');
    const { session, events } = await parseClaudeSession(file);
    assert.equal(session.skipped, 1);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.kind), ['user', 'assistant']);
  });

  test('last-cwd-wins with subdirectory ancestor collapse (reduceCwd)', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'moved-repo-session.jsonl');
    const lines = [
      { type: 'user', sessionId: 's', cwd: '/home/user/old-repo', uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'start' } },
      { type: 'user', sessionId: 's', cwd: '/home/user/new-repo', uuid: 'u2', timestamp: '2026-08-01T00:01:00.000Z', message: { role: 'user', content: 'moved' } },
      // Latest recorded cwd is a subdirectory of the previously-seen root; reduceCwd
      // should collapse it back up to the seen ancestor '/home/user/new-repo'.
      { type: 'user', sessionId: 's', cwd: '/home/user/new-repo/server', uuid: 'u3', timestamp: '2026-08-01T00:02:00.000Z', message: { role: 'user', content: 'in subdir' } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { session } = await parseClaudeSession(file);
    assert.equal(session.cwd, '/home/user/new-repo');
  });

  test('without ancestor collapse, plain last-cwd-wins picks the most recently recorded cwd', async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, 'plain-last-cwd-session.jsonl');
    const lines = [
      { type: 'user', sessionId: 's', cwd: '/home/user/repo-one', uuid: 'u1', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'a' } },
      { type: 'user', sessionId: 's', cwd: '/home/user/repo-two', uuid: 'u2', timestamp: '2026-08-01T00:01:00.000Z', message: { role: 'user', content: 'b' } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const { session } = await parseClaudeSession(file);
    assert.equal(session.cwd, '/home/user/repo-two');
  });
});

describe('parseClaudeLine — direct unit tests on synthetic lines', () => {
  test('user string content starting with <command-name> is skipped entirely', () => {
    const events = parseClaudeLine({
      type: 'user',
      message: { role: 'user', content: '<command-name>/rename</command-name>' },
    });
    assert.deepEqual(events, []);
  });

  test('user string content starting with <local-command is skipped entirely', () => {
    const events = parseClaudeLine({
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' },
    });
    assert.deepEqual(events, []);
  });

  test('user array content: a <system-reminder> text block is dropped, a normal text block is kept', () => {
    const events = parseClaudeLine({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>internal note, not a real prompt</system-reminder>' },
          { type: 'text', text: 'actual human text' },
        ],
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'user');
    assert.equal(events[0].text, 'actual human text');
  });

  test('plain user string content (not a command/local-command) becomes a single user event', () => {
    const events = parseClaudeLine({
      type: 'user',
      uuid: 'u9',
      timestamp: '2026-08-01T00:00:00.000Z',
      message: { role: 'user', content: 'a normal prompt' },
    });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { uuid: 'u9', ts: '2026-08-01T00:00:00.000Z', kind: 'user', text: 'a normal prompt' });
  });

  test('assistant thinking block produces a kind:"thinking" event carrying the model', () => {
    const events = parseClaudeLine({
      type: 'assistant',
      uuid: 'a9',
      timestamp: '2026-08-01T00:00:00.000Z',
      message: { model: 'claude-fable-5', content: [{ type: 'thinking', thinking: 'pondering the problem' }] },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'thinking');
    assert.equal(events[0].text, 'pondering the problem');
    assert.equal(events[0].model, 'claude-fable-5');
  });

  test('isSidechain:true stamps is_sidechain=1 on every event the line produces', () => {
    const events = parseClaudeLine({
      type: 'assistant',
      isSidechain: true,
      uuid: 'a10',
      timestamp: '2026-08-01T00:00:00.000Z',
      message: { model: 'm', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'tt', name: 'Bash', input: { cmd: 'ls' } }] },
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].is_sidechain, 1);
    assert.equal(events[1].is_sidechain, 1);
  });

  test('tool_use block stringifies tool_input as JSON and carries tool_use_id', () => {
    const events = parseClaudeLine({
      type: 'assistant',
      uuid: 'a11',
      timestamp: '2026-08-01T00:00:00.000Z',
      message: { model: 'm', content: [{ type: 'tool_use', id: 'tool-xyz', name: 'Bash', input: { command: 'ls -la' } }] },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'tool_use');
    assert.equal(events[0].tool_name, 'Bash');
    assert.equal(events[0].tool_use_id, 'tool-xyz');
    assert.equal(events[0].tool_input, JSON.stringify({ command: 'ls -la' }));
  });

  test('blank/whitespace-only assistant text block produces no event', () => {
    const events = parseClaudeLine({
      type: 'assistant',
      uuid: 'a12',
      timestamp: '2026-08-01T00:00:00.000Z',
      message: { model: 'm', content: [{ type: 'text', text: '   ' }] },
    });
    assert.deepEqual(events, []);
  });
});
