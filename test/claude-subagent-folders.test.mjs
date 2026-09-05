// Task 2 (spec §2.7): subagent transcript folder ingestion.
//
// Real Claude Code sessions write subagent transcripts to
//   <logDir>/<sessionId>/subagents/agent-<hex17>.jsonl (+ sibling .meta.json)
// with an additional nesting for orchestrated "workflow" agents:
//   <logDir>/<sessionId>/subagents/workflows/wf_<id>/agent-<hex17>.jsonl (+ .meta.json)
// Prior to this task, parseClaudeSession only picked up files directly under
// subagents/ (not workflows/*), never read the .meta.json sidecar, and had no
// uuid-based dedup against inline sidechain entries. These tests pin the new
// behavior using Task 1's deterministic big-session fixture (120 subagents:
// 100 workflow + 20 direct) plus small hand-rolled fixtures for dedup and
// scanner-freshness behavior that the big fixture doesn't exercise.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateBigSession,
  FIXTURE_SUBAGENT_COUNT,
  FIXTURE_WORKFLOW_SUBAGENT_COUNT,
  FIXTURE_DIRECT_SUBAGENT_COUNT,
} from './fixtures/gen-big-session.mjs';
import { parseClaudeSession, scanClaudeProjects } from '../server/parsers/claudeCode.ts';
import { subagentRunCount } from '../src/session/stats.ts';

const tmpDirs = [];
function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-subfolders-test-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function findFiles(dir, re) {
  const out = [];
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    if (dirent.isDirectory()) out.push(...findFiles(full, re));
    else if (re.test(dirent.name)) out.push(full);
  }
  return out;
}

function countNonEmptyLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
}

function firstLineJSON(file) {
  const l = fs.readFileSync(file, 'utf8').split('\n').find((s) => s.trim());
  return JSON.parse(l);
}

describe('parseClaudeSession — subagent folder ingestion (big fixture, 120 agents)', () => {
  test('every file-based agent line is ingested exactly once: sidechain event count == sum of on-disk agent line counts', async () => {
    const dir = makeTmpDir();
    const { mainFile, sessionId } = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(mainFile), sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    const agentFiles = findFiles(subagentsDir, /^agent-.*\.jsonl$/);
    assert.equal(agentFiles.length, FIXTURE_SUBAGENT_COUNT);
    const expectedSidechainEvents = agentFiles.reduce((n, f) => n + countNonEmptyLines(f), 0);

    const { events } = await parseClaudeSession(mainFile);
    const sidechainEvents = events.filter((e) => e.is_sidechain === 1);
    // No double-counting (would exceed expected) and nothing dropped (would fall short).
    assert.equal(sidechainEvents.length, expectedSidechainEvents);
  });

  test('workflow agents get workflow_id === "wf_fixture01"; direct agents get workflow_id null/undefined', async () => {
    const dir = makeTmpDir();
    const { mainFile, sessionId } = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(mainFile), sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    const workflowDir = path.join(subagentsDir, 'workflows', 'wf_fixture01');
    const workflowFiles = findFiles(workflowDir, /^agent-.*\.jsonl$/);
    const directFiles = fs.readdirSync(subagentsDir).filter((f) => /^agent-.*\.jsonl$/.test(f))
      .map((f) => path.join(subagentsDir, f));
    assert.equal(workflowFiles.length, FIXTURE_WORKFLOW_SUBAGENT_COUNT);
    assert.equal(directFiles.length, FIXTURE_DIRECT_SUBAGENT_COUNT);

    const workflowUuids = new Set(workflowFiles.flatMap((f) =>
      fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).uuid)));
    const directUuids = new Set(directFiles.flatMap((f) =>
      fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).uuid)));

    const { events } = await parseClaudeSession(mainFile);
    const byUuid = new Map(events.map((e) => [e.uuid, e]));

    let checkedWorkflow = 0;
    for (const u of workflowUuids) {
      const e = byUuid.get(u);
      assert.ok(e, `workflow uuid ${u} missing from parsed events`);
      assert.equal(e.workflow_id, 'wf_fixture01');
      checkedWorkflow++;
    }
    assert.ok(checkedWorkflow > 0);

    let checkedDirect = 0;
    for (const u of directUuids) {
      const e = byUuid.get(u);
      assert.ok(e, `direct uuid ${u} missing from parsed events`);
      assert.ok(e.workflow_id === null || e.workflow_id === undefined, `direct agent event ${u} unexpectedly has workflow_id ${e.workflow_id}`);
      checkedDirect++;
    }
    assert.ok(checkedDirect > 0);
  });

  test('workflow agents (no inline Task-prompt pairing) get agent_type from meta.json fallback', async () => {
    const dir = makeTmpDir();
    const { mainFile, sessionId } = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(mainFile), sessionId);
    const workflowDir = path.join(sessionDir, 'subagents', 'workflows', 'wf_fixture01');
    const workflowFiles = findFiles(workflowDir, /^agent-.*\.jsonl$/);
    // Spot-check a handful of workflow agents against their own meta.json.
    const { events } = await parseClaudeSession(mainFile);
    const byUuid = new Map(events.map((e) => [e.uuid, e]));
    for (const f of workflowFiles.slice(0, 10)) {
      const meta = JSON.parse(fs.readFileSync(f.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      const firstUuid = firstLineJSON(f).uuid;
      const e = byUuid.get(firstUuid);
      assert.ok(e, `first line of ${f} missing from parsed events`);
      assert.equal(e.agent_type, meta.agentType, `${f} agent_type mismatch with meta.json`);
    }
  });

  test('events within one agent file stay ts-ordered in the output', async () => {
    const dir = makeTmpDir();
    const { mainFile, sessionId } = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(mainFile), sessionId);
    const workflowDir = path.join(sessionDir, 'subagents', 'workflows', 'wf_fixture01');
    const oneFile = findFiles(workflowDir, /^agent-.*\.jsonl$/)[0];
    const fileUuidsInOrder = fs.readFileSync(oneFile, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => JSON.parse(l).uuid);

    const { events } = await parseClaudeSession(mainFile);
    const indices = fileUuidsInOrder.map((u) => events.findIndex((e) => e.uuid === u));
    for (const i of indices) assert.notEqual(i, -1);
    // Positions must be strictly increasing (file order preserved in the output).
    for (let i = 1; i < indices.length; i++) assert.ok(indices[i] > indices[i - 1]);
    // Timestamps must be non-decreasing across those positions.
    const ts = indices.map((i) => Date.parse(events[i].ts));
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1]);
  });

  test('summed usage tokens with subagents ingested exceed main-file-only usage (subagent spend counted)', async () => {
    const dir = makeTmpDir();
    const { mainFile, sessionId } = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(mainFile), sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    const hidden = `${subagentsDir}.hidden`;

    fs.renameSync(subagentsDir, hidden);
    const baseline = await parseClaudeSession(mainFile);
    fs.renameSync(hidden, subagentsDir);
    const full = await parseClaudeSession(mainFile);

    const sumTokens = (usageJson) => {
      if (!usageJson) return 0;
      const usage = JSON.parse(usageJson);
      let total = 0;
      for (const m of Object.values(usage)) total += m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h;
      return total;
    };
    const baselineTotal = sumTokens(baseline.session.usage);
    const fullTotal = sumTokens(full.session.usage);
    assert.ok(fullTotal > baselineTotal, `expected full (${fullTotal}) > baseline (${baselineTotal})`);
  });

  test('context_tokens is unaffected by subagent ingestion (main-chain only)', async () => {
    const dir = makeTmpDir();
    const { mainFile, sessionId } = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(mainFile), sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    const hidden = `${subagentsDir}.hidden`;

    fs.renameSync(subagentsDir, hidden);
    const baseline = await parseClaudeSession(mainFile);
    fs.renameSync(hidden, subagentsDir);
    const full = await parseClaudeSession(mainFile);

    assert.equal(full.session.context_tokens, baseline.session.context_tokens);
  });
});

describe('parseClaudeSession — per-run agent_id (Overview Subagents card header is run-level, not type-level)', () => {
  test('every file-based subagent event carries a non-null agent_id, and the fixture yields exactly 120 distinct ids', async () => {
    const dir = makeTmpDir();
    const { mainFile } = generateBigSession(dir);
    const { events } = await parseClaudeSession(mainFile);
    const sidechainEvents = events.filter((e) => e.is_sidechain === 1);
    assert.ok(sidechainEvents.length > 0);
    for (const e of sidechainEvents) assert.ok(e.agent_id, `sidechain event uuid=${e.uuid} missing agent_id`);
    const distinctIds = new Set(sidechainEvents.map((e) => e.agent_id));
    assert.equal(distinctIds.size, FIXTURE_SUBAGENT_COUNT);
  });

  test('agent_id is the hex id from the file name (agent-<hex>.jsonl), not the meta.json agentType', async () => {
    const dir = makeTmpDir();
    const { mainFile, sessionId } = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(mainFile), sessionId);
    const workflowDir = path.join(sessionDir, 'subagents', 'workflows', 'wf_fixture01');
    const oneFile = findFiles(workflowDir, /^agent-.*\.jsonl$/)[0];
    const expectedId = path.basename(oneFile).replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const firstUuid = firstLineJSON(oneFile).uuid;

    const { events } = await parseClaudeSession(mainFile);
    const e = events.find((ev) => ev.uuid === firstUuid);
    assert.ok(e);
    assert.equal(e.agent_id, expectedId);
  });

  test('stats-level: subagentRunCount (the Overview Subagents card header source) returns 120 for the fixture session', async () => {
    const dir = makeTmpDir();
    const { mainFile } = generateBigSession(dir);
    const { events } = await parseClaudeSession(mainFile);
    // subagentRunCount is exactly what OverviewMode.tsx feeds the card
    // header — testing it directly against the parser's real output is the
    // "without a browser" equivalent of the UI assertion.
    assert.equal(subagentRunCount(events), FIXTURE_SUBAGENT_COUNT);
    assert.equal(subagentRunCount(events), 120);
  });

  // Task 11: the sidecar's `description` field, previously read then
  // discarded (see the old AgentMeta comment), now flows onto every event of
  // the run as agent_desc — the source for the run list's Description column.
  test('agent_desc: every file-based subagent event carries its meta.json description', async () => {
    const dir = makeTmpDir();
    const { mainFile, sessionId } = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(mainFile), sessionId);
    const workflowDir = path.join(sessionDir, 'subagents', 'workflows', 'wf_fixture01');
    const oneFile = findFiles(workflowDir, /^agent-.*\.jsonl$/)[0];
    const meta = JSON.parse(fs.readFileSync(oneFile.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    assert.ok(meta.description, 'fixture meta.json must carry a description for this test to be meaningful');
    const firstUuid = firstLineJSON(oneFile).uuid;

    const { events } = await parseClaudeSession(mainFile);
    const e = events.find((ev) => ev.uuid === firstUuid);
    assert.ok(e);
    assert.equal(e.agent_desc, meta.description);
  });

  // Distinct agent_types must each have MULTIPLE runs in the fixture (5 types,
  // 120 runs) — this is what smoke.spec.ts's e2e run-list assertion relies on.
  test('the fixture spreads 120 runs across only 5 agent_types, so every type has >1 run', async () => {
    const dir = makeTmpDir();
    const { mainFile } = generateBigSession(dir);
    const { events } = await parseClaudeSession(mainFile);
    const byType = new Map();
    for (const e of events) {
      if (!e.is_sidechain || !e.agent_type || !e.agent_id) continue;
      if (!byType.has(e.agent_type)) byType.set(e.agent_type, new Set());
      byType.get(e.agent_type).add(e.agent_id);
    }
    assert.ok(byType.size > 1);
    for (const [type, ids] of byType) assert.ok(ids.size > 1, `agent_type ${type} has only ${ids.size} run(s)`);
  });
});

describe('parseClaudeSession — dedup by uuid against inline sidechain entries', () => {
  test('a subagent-file line whose uuid already appeared in the main file is not double-counted', async () => {
    const dir = makeTmpDir();
    const sessionId = 'dedup-session';
    const projectDir = path.join(dir, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionDir = path.join(projectDir, sessionId);
    const subagentsDir = path.join(sessionDir, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });

    const mainLines = [
      { type: 'user', sessionId, cwd: '/tmp/dedup-proj', uuid: 'u0', timestamp: '2026-08-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
      // Inline sidechain entry that ALSO exists (duplicated) in the agent file below.
      // Carries the same agentId 'ag1' the file's own name will resolve to, matching
      // real Claude Code logs where a duplicated line keeps its agentId either place.
      {
        type: 'assistant', sessionId, isSidechain: true, agentId: 'ag1', uuid: 'dup1', timestamp: '2026-08-01T00:00:05.000Z',
        message: { model: 'm', content: [{ type: 'text', text: 'duplicated sidechain line' }] },
      },
    ];
    const mainFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(mainFile, mainLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const agentLines = [
      // Same uuid as the inline entry above — must be skipped, not duplicated.
      {
        type: 'assistant', sessionId, isSidechain: true, agentId: 'ag1', uuid: 'dup1', timestamp: '2026-08-01T00:00:05.000Z',
        message: { model: 'm', content: [{ type: 'text', text: 'duplicated sidechain line' }] },
      },
      // A genuinely new line — must be included.
      {
        type: 'assistant', sessionId, isSidechain: true, agentId: 'ag1', uuid: 'new1', timestamp: '2026-08-01T00:00:06.000Z',
        message: { model: 'm', content: [{ type: 'text', text: 'new sidechain line' }] },
      },
    ];
    fs.writeFileSync(path.join(subagentsDir, 'agent-ag1.jsonl'), agentLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const { events } = await parseClaudeSession(mainFile);
    const dupMatches = events.filter((e) => e.uuid === 'dup1');
    assert.equal(dupMatches.length, 1, 'uuid dup1 must appear exactly once in the output');
    assert.ok(events.some((e) => e.uuid === 'new1'), 'genuinely new subagent line must still be ingested');
    const sidechainEvents = events.filter((e) => e.is_sidechain === 1);
    assert.equal(sidechainEvents.length, 2, 'exactly 2 distinct sidechain events (dup1 once + new1)');

    // Run-count must not be inflated by the dedup: 'dup1' (kept from the main
    // file, stamped agent_id 'ag1' via its own inline agentId field) and
    // 'new1' (kept from the agent file, stamped agent_id 'ag1' from the file
    // name) both belong to the SAME run — subagentRunCount must report 1, not 2.
    assert.equal(subagentRunCount(events), 1);
  });
});

describe('scanClaudeProjects — effective mtime includes the subagents tree', () => {
  test('touching a workflow agent file newer than the main file bumps the reported modifiedAt', async () => {
    const dir = makeTmpDir();
    const { mainFile, sessionId } = generateBigSession(dir);
    const sessionDir = path.join(path.dirname(mainFile), sessionId);
    const workflowDir = path.join(sessionDir, 'subagents', 'workflows', 'wf_fixture01');
    const oneAgentFile = findFiles(workflowDir, /^agent-.*\.jsonl$/)[0];

    const before = scanClaudeProjects(dir)[0].sessions.find((s) => s.id === sessionId);
    assert.ok(before);

    // Bump the main file's mtime far into the past, then touch one workflow
    // agent file to a clearly-later time, so the effective mtime must come
    // from the subagents tree, not the main file.
    const past = new Date('2020-01-01T00:00:00.000Z');
    const future = new Date('2099-01-01T00:00:00.000Z');
    fs.utimesSync(mainFile, past, past);
    fs.utimesSync(oneAgentFile, future, future);

    const after = scanClaudeProjects(dir)[0].sessions.find((s) => s.id === sessionId);
    assert.ok(after);
    assert.equal(new Date(after.modifiedAt).getTime(), future.getTime());
  });
});
