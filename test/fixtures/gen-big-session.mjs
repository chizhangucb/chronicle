// Deterministic big-session fixture generator.
//
// Produces a realistic-shaped, large Claude Code transcript on disk: one main
// session JSONL (FIXTURE_MAIN_MESSAGES lines) plus FIXTURE_SUBAGENT_COUNT
// subagent transcripts laid out exactly like real Claude Code logs —
//   <destDir>/<munged-project>/<sessionId>.jsonl                                   (main)
//   <destDir>/<munged-project>/<sessionId>/subagents/agent-<hex17>.jsonl(.meta.json)      (20 direct)
//   <destDir>/<munged-project>/<sessionId>/subagents/workflows/wf_fixture01/agent-<hex17>.jsonl(.meta.json)  (100 workflow)
// — used by parser stress tests and the E2E suite as a stable large fixture.
//
// Determinism: everything is derived from a seeded counter (a plain LCG) and
// a fixed base timestamp (2026-08-01T00:00:00Z). No Date.now(), no
// Math.random(), no filesystem stat/mtime reads feed into content — two runs
// (even into different dirs) produce byte-identical files. node:crypto's
// createHash (not a source of randomness — sha1 of a deterministic input) is
// used only to mint realistic-looking hex ids from the counter.
//
// No dependencies beyond node builtins.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FIXTURE_SUBAGENT_COUNT = 120; // 100 workflow + 20 direct
export const FIXTURE_WORKFLOW_SUBAGENT_COUNT = 100;
export const FIXTURE_DIRECT_SUBAGENT_COUNT = 20;
export const FIXTURE_MAIN_MESSAGES = 5000;

const FIXTURE_SESSION_ID = 'bigfix-0001';
const FIXTURE_WORKFLOW_ID = 'wf_fixture01';
const FIXTURE_CWD = '/tmp/fixture-project';
const MODEL = 'claude-fable-5';
const BASE_TS = Date.parse('2026-08-01T00:00:00.000Z');
const DEFAULT_SEED = 42;

const AGENT_TYPES = ['general-purpose', 'Explore', 'code-reviewer', 'Plan', 'test-runner'];
const GENERIC_TOOLS = ['Bash', 'Read', 'Edit', 'Grep', 'Write'];

// cwd '/tmp/fixture-project' -> '-tmp-fixture-project' (dashes for slashes).
function mungeProjectDir(cwd) {
  return cwd.replace(/\//g, '-');
}

// Seeded LCG (Numerical Recipes constants) — deterministic pseudo-random
// integer stream from a fixed seed. Never Math.random().
function makeCounter(seed) {
  let n = seed >>> 0;
  return () => {
    n = (Math.imul(1664525, n) + 1013904223) >>> 0;
    return n;
  };
}

// Deterministic hex id (not a source of randomness itself — sha1 of a
// counter-derived string) shaped like Claude Code's real agent-<hex17> ids.
function hexId(next, len = 17) {
  return crypto.createHash('sha1').update(String(next())).digest('hex').slice(0, len);
}

function uuidLike(next) {
  const h = crypto.createHash('sha1').update(`uuid:${next()}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Advances a shared timestamp cursor by 2-40s (deterministic) and returns ISO.
function makeClock(next) {
  let cursor = BASE_TS;
  return () => {
    const incSec = 2 + (next() % 39); // 2..40
    cursor += incSec * 1000;
    return new Date(cursor).toISOString();
  };
}

function usageBlock(next) {
  return {
    input_tokens: 50 + (next() % 400),
    output_tokens: 20 + (next() % 200),
    cache_read_input_tokens: next() % 2000,
    cache_creation: {
      ephemeral_5m_input_tokens: next() % 300,
      ephemeral_1h_input_tokens: next() % 20 === 0 ? next() % 500 : 0,
    },
  };
}

// Evenly spaced distinct indices in [0, count) — used to spread tool_use
// turns deterministically through the transcript rather than clustering them.
function spreadIndices(countSlots, countPicks, offset = 0) {
  const picks = [];
  for (let i = 0; i < countPicks; i++) {
    picks.push(offset + Math.floor((i * countSlots) / countPicks));
  }
  return picks;
}

function jsonLine(obj) {
  return JSON.stringify(obj) + '\n';
}

/**
 * Generate a deterministic large fixture session on disk.
 * @param {string} destDir - directory to write the munged project dir into.
 * @param {{seed?: number}} [opts]
 * @returns {{sessionId: string, mainFile: string, agentCount: number, totalMessages: number}}
 */
export function generateBigSession(destDir, opts = {}) {
  const seed = opts.seed ?? DEFAULT_SEED;
  const next = makeCounter(seed);
  const clock = makeClock(next);

  const sessionId = FIXTURE_SESSION_ID;
  const projectDir = path.join(destDir, mungeProjectDir(FIXTURE_CWD));
  const sessionDir = path.join(projectDir, sessionId);
  const subagentsDir = path.join(sessionDir, 'subagents');
  const workflowDir = path.join(subagentsDir, 'workflows', FIXTURE_WORKFLOW_ID);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.mkdirSync(workflowDir, { recursive: true });

  // ── Plan the main transcript's line budget ───────────────────────────────
  // 2450 base (user, assistant) turns = 4900 lines.
  // + 20 of those assistant turns carry a Task tool_use, each followed by one
  //   extra tool_result line (paired with a direct subagent's first prompt) = +20
  // + 80 of those assistant turns carry a generic tool_use (Bash/Read/Edit/…),
  //   each followed by one extra tool_result line (~1/4 error heads) = +80
  // 4900 + 20 + 80 = 5000 = FIXTURE_MAIN_MESSAGES.
  const TURNS = 2450;
  const taskTurnIdx = new Set(spreadIndices(TURNS, FIXTURE_DIRECT_SUBAGENT_COUNT, 10));
  const genericTurnIdx = new Set(
    spreadIndices(TURNS, 80, 5).filter((i) => !taskTurnIdx.has(i))
  );
  // Ensure exactly 20 task turns and 80 generic turns even after de-dup by
  // topping up from unused slots if the filter above removed a collision.
  {
    let cursor = 1;
    while (genericTurnIdx.size < 80 && cursor < TURNS) {
      if (!taskTurnIdx.has(cursor) && !genericTurnIdx.has(cursor)) genericTurnIdx.add(cursor);
      cursor++;
    }
  }

  const taskPrompts = []; // index-ordered, one per direct subagent
  for (let i = 0; i < FIXTURE_DIRECT_SUBAGENT_COUNT; i++) {
    taskPrompts.push(`Investigate fixture task ${i + 1}: survey module ${i + 1} and report findings.`);
  }

  const mainLines = [];
  let parentUuid = null;
  let taskCallCounter = 0;
  let genericCallCounter = 0;
  const taskToolUseIds = []; // toolUseId per direct agent (paired with meta.json)

  for (let t = 0; t < TURNS; t++) {
    // user turn
    const userUuid = uuidLike(next);
    mainLines.push(jsonLine({
      type: 'user',
      sessionId,
      cwd: FIXTURE_CWD,
      uuid: userUuid,
      parentUuid,
      timestamp: clock(),
      message: { role: 'user', content: `Fixture prompt #${t + 1}: please continue the work.` },
    }));
    parentUuid = userUuid;

    // assistant turn
    const asstUuid = uuidLike(next);
    const isTaskTurn = taskTurnIdx.has(t);
    const isGenericTurn = genericTurnIdx.has(t);
    const content = [{ type: 'text', text: `Fixture response #${t + 1}: working on it.` }];
    let pendingToolUseId = null;
    let pendingIsError = false;

    if (isTaskTurn) {
      const idx = taskCallCounter++;
      const toolUseId = `toolu_task_${String(idx).padStart(3, '0')}`;
      taskToolUseIds.push(toolUseId);
      content.push({
        type: 'tool_use',
        id: toolUseId,
        name: 'Task',
        input: { subagent_type: AGENT_TYPES[idx % AGENT_TYPES.length], prompt: taskPrompts[idx] },
      });
      pendingToolUseId = toolUseId;
    } else if (isGenericTurn) {
      const idx = genericCallCounter++;
      const toolUseId = `toolu_gen_${String(idx).padStart(3, '0')}`;
      const toolName = GENERIC_TOOLS[idx % GENERIC_TOOLS.length];
      content.push({
        type: 'tool_use',
        id: toolUseId,
        name: toolName,
        input: { path: `src/fixture-${idx}.ts`, command: `echo fixture-${idx}` },
      });
      pendingToolUseId = toolUseId;
      pendingIsError = idx % 4 === 0; // ~1/4 of generic calls report an error
    }

    mainLines.push(jsonLine({
      type: 'assistant',
      sessionId,
      uuid: asstUuid,
      parentUuid,
      timestamp: clock(),
      message: { role: 'assistant', model: MODEL, content, usage: usageBlock(next) },
    }));
    parentUuid = asstUuid;

    if (pendingToolUseId) {
      const resultUuid = uuidLike(next);
      const resultText = pendingIsError
        ? `Error: fixture command failed with exit code 1`
        : `fixture tool result ${pendingToolUseId}`;
      mainLines.push(jsonLine({
        type: 'user',
        sessionId,
        cwd: FIXTURE_CWD,
        uuid: resultUuid,
        parentUuid,
        timestamp: clock(),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: pendingToolUseId, content: resultText }],
        },
      }));
      parentUuid = resultUuid;
    }
  }

  const mainFile = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(mainFile, mainLines.join(''));

  // ── Subagent files ────────────────────────────────────────────────────
  // 20 direct (paired 1:1 with the Task calls above) + 100 workflow.
  for (let i = 0; i < FIXTURE_DIRECT_SUBAGENT_COUNT; i++) {
    writeAgentFile({
      dir: subagentsDir,
      next,
      clock,
      sessionId,
      agentType: AGENT_TYPES[i % AGENT_TYPES.length],
      toolUseId: taskToolUseIds[i],
      firstUserText: taskPrompts[i],
      spawnDepth: 1,
      indexLabel: `direct-${i}`,
    });
  }
  for (let i = 0; i < FIXTURE_WORKFLOW_SUBAGENT_COUNT; i++) {
    writeAgentFile({
      dir: workflowDir,
      next,
      clock,
      sessionId,
      agentType: AGENT_TYPES[i % AGENT_TYPES.length],
      toolUseId: `toolu_wf_${String(i).padStart(3, '0')}`,
      firstUserText: `Workflow subtask ${i + 1}: process batch item ${i + 1}.`,
      spawnDepth: 2,
      indexLabel: `workflow-${i}`,
    });
  }

  return {
    sessionId,
    mainFile,
    agentCount: FIXTURE_SUBAGENT_COUNT,
    totalMessages: mainLines.length,
  };
}

// Writes one agent-<hex17>.jsonl (30-80 lines, isSidechain:true) + sibling
// agent-<hex17>.meta.json into `dir`.
function writeAgentFile({ dir, next, clock, sessionId, agentType, toolUseId, firstUserText, spawnDepth, indexLabel }) {
  const agentId = hexId(next, 17);
  const lineCount = 30 + (next() % 51); // 30..80
  const lines = [];
  let parentUuid = null;

  for (let i = 0; i < lineCount; i++) {
    const isUserTurn = i % 2 === 0;
    const uuid = uuidLike(next);
    if (isUserTurn) {
      const text = i === 0 ? firstUserText : `Sidechain follow-up ${i} for ${indexLabel}.`;
      lines.push(jsonLine({
        parentUuid,
        isSidechain: true,
        agentId,
        cwd: FIXTURE_CWD,
        entrypoint: 'cli',
        gitBranch: 'main',
        type: 'user',
        userType: 'external',
        sessionId,
        promptId: `prompt-${agentId}-${i}`,
        uuid,
        timestamp: clock(),
        version: '2.1.0',
        message: { role: 'user', content: text },
      }));
    } else {
      lines.push(jsonLine({
        parentUuid,
        isSidechain: true,
        agentId,
        cwd: FIXTURE_CWD,
        entrypoint: 'cli',
        gitBranch: 'main',
        type: 'assistant',
        userType: 'external',
        sessionId,
        promptId: `prompt-${agentId}-${i}`,
        uuid,
        timestamp: clock(),
        version: '2.1.0',
        message: {
          role: 'assistant',
          model: MODEL,
          content: [{ type: 'text', text: `Sidechain response ${i} for ${indexLabel}.` }],
          usage: usageBlock(next),
        },
      }));
    }
    parentUuid = uuid;
  }

  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), lines.join(''));
  fs.writeFileSync(
    path.join(dir, `agent-${agentId}.meta.json`),
    JSON.stringify({
      agentType,
      description: `Fixture ${indexLabel} subagent (${agentType})`,
      toolUseId,
      spawnDepth,
    })
  );
}
