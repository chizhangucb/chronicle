// Characterization/contract test for the deterministic big-session fixture
// generator (test/fixtures/gen-big-session.mjs). This fixture backs later
// parser stress tests and the E2E suite, so its shape is pinned here:
// - main transcript JSONL with FIXTURE_MAIN_MESSAGES lines
// - FIXTURE_SUBAGENT_COUNT subagent files (100 workflow + 20 direct), each
//   with a sibling .meta.json, laid out exactly like real Claude Code logs
//   (<sessionId>/subagents/agent-*.jsonl + subagents/workflows/wf_*/agent-*.jsonl)
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateBigSession,
  FIXTURE_SUBAGENT_COUNT,
  FIXTURE_MAIN_MESSAGES,
} from './fixtures/gen-big-session.mjs';

const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-bigfix-test-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Recursively find all files under `dir` whose basename matches `re`.
function findFiles(dir, re) {
  const out = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...findFiles(full, re));
    else if (re.test(dirent.name)) out.push(full);
  }
  return out;
}

describe('generateBigSession', () => {
  test('ground-truth constants match the brief', () => {
    assert.equal(FIXTURE_SUBAGENT_COUNT, 120);
    assert.equal(FIXTURE_MAIN_MESSAGES, 5000);
  });

  test('main JSONL has exactly FIXTURE_MAIN_MESSAGES lines', () => {
    const dir = makeTmpDir();
    const result = generateBigSession(dir);
    const text = fs.readFileSync(result.mainFile, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    assert.equal(lines.length, FIXTURE_MAIN_MESSAGES);
    // Every line must be valid JSON.
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });

  test('return value reports sessionId, agentCount, totalMessages consistent with the constants', () => {
    const dir = makeTmpDir();
    const result = generateBigSession(dir);
    assert.equal(typeof result.sessionId, 'string');
    assert.ok(result.sessionId.length > 0);
    assert.equal(result.agentCount, FIXTURE_SUBAGENT_COUNT);
    assert.equal(result.totalMessages, FIXTURE_MAIN_MESSAGES);
    assert.ok(fs.existsSync(result.mainFile));
  });

  test('exactly FIXTURE_SUBAGENT_COUNT agent-*.jsonl files exist under the session subagents dir', () => {
    const dir = makeTmpDir();
    const result = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(result.mainFile), result.sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    assert.ok(fs.existsSync(subagentsDir));
    const agentFiles = findFiles(subagentsDir, /^agent-.*\.jsonl$/);
    assert.equal(agentFiles.length, FIXTURE_SUBAGENT_COUNT);
  });

  test('every agent file first line parses as JSON with isSidechain:true and an agentId', () => {
    const dir = makeTmpDir();
    const result = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(result.mainFile), result.sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    const agentFiles = findFiles(subagentsDir, /^agent-.*\.jsonl$/);
    assert.ok(agentFiles.length > 0);
    for (const f of agentFiles) {
      const firstLine = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.trim());
      const obj = JSON.parse(firstLine);
      assert.equal(obj.isSidechain, true, `${f} first line missing isSidechain:true`);
      assert.ok(obj.agentId, `${f} first line missing agentId`);
    }
  });

  test('every agent-*.meta.json sibling parses with an agentType string', () => {
    const dir = makeTmpDir();
    const result = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(result.mainFile), result.sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    const metaFiles = findFiles(subagentsDir, /^agent-.*\.meta\.json$/);
    assert.equal(metaFiles.length, FIXTURE_SUBAGENT_COUNT);
    for (const f of metaFiles) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.equal(typeof obj.agentType, 'string');
      assert.ok(obj.agentType.length > 0, `${f} agentType is empty`);
    }
  });

  test('workflow agents live under subagents/workflows/wf_fixture01/', () => {
    const dir = makeTmpDir();
    const result = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(result.mainFile), result.sessionId);
    const workflowDir = path.join(sessionDir, 'subagents', 'workflows', 'wf_fixture01');
    assert.ok(fs.existsSync(workflowDir), 'workflow dir wf_fixture01 missing');
    const workflowAgentFiles = findFiles(workflowDir, /^agent-.*\.jsonl$/);
    // 100 workflow + 20 direct = 120; workflow agents are the ones under this dir.
    assert.equal(workflowAgentFiles.length, FIXTURE_SUBAGENT_COUNT - 20);
    // And the direct 20 must NOT be inside the workflow dir (they sit directly
    // under subagents/).
    const directDir = path.join(sessionDir, 'subagents');
    const directAgentFiles = fs.readdirSync(directDir).filter((f) => /^agent-.*\.jsonl$/.test(f));
    assert.equal(directAgentFiles.length, 20);
  });

  test('agent files are each 30-80 lines', () => {
    const dir = makeTmpDir();
    const result = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(result.mainFile), result.sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    const agentFiles = findFiles(subagentsDir, /^agent-.*\.jsonl$/);
    for (const f of agentFiles) {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
      assert.ok(lines.length >= 30 && lines.length <= 80, `${f} has ${lines.length} lines (expected 30-80)`);
    }
  });

  test('main file has 20 inline Task tool_use calls whose prompts pair with the 20 direct agents first user messages', () => {
    const dir = makeTmpDir();
    const result = generateBigSession(dir);
    const mainLines = fs.readFileSync(result.mainFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const taskPrompts = new Set();
    for (const o of mainLines) {
      const content = o.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.name === 'Task') {
            taskPrompts.add(block.input.prompt);
          }
        }
      }
    }
    assert.equal(taskPrompts.size, 20);

    const sessionDir = path.join(path.dirname(result.mainFile), result.sessionId);
    const directAgentFiles = fs.readdirSync(path.join(sessionDir, 'subagents'))
      .filter((f) => /^agent-.*\.jsonl$/.test(f))
      .map((f) => path.join(sessionDir, 'subagents', f));
    for (const f of directAgentFiles) {
      const firstLine = fs.readFileSync(f, 'utf8').split('\n').find((l) => l.trim());
      const obj = JSON.parse(firstLine);
      const text = typeof obj.message?.content === 'string'
        ? obj.message.content
        : obj.message?.content?.find((b) => b.type === 'text')?.text;
      assert.ok(taskPrompts.has(text), `direct agent ${f} first user message has no matching Task prompt`);
    }
  });

  test('deterministic: two runs into different dirs produce byte-identical main files', () => {
    const dirA = makeTmpDir();
    const dirB = makeTmpDir();
    const resultA = generateBigSession(dirA);
    const resultB = generateBigSession(dirB);
    const textA = fs.readFileSync(resultA.mainFile, 'utf8');
    const textB = fs.readFileSync(resultB.mainFile, 'utf8');
    assert.equal(textA, textB);
  });

  test('some tool_result lines carry an Error: head (error-count truth)', () => {
    const dir = makeTmpDir();
    const result = generateBigSession(dir);
    const mainLines = fs.readFileSync(result.mainFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    let errorCount = 0;
    for (const o of mainLines) {
      const content = o.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.startsWith('Error:')) {
            errorCount++;
          }
        }
      }
    }
    assert.ok(errorCount > 0, 'expected at least one Error: tool_result head');
  });
});
