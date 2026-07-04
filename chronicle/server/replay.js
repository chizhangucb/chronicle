import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { db } from './db.js';
import * as gitEngine from './git.js';

// Replay Mode (FR-RP): deterministic re-execution of session operations in an
// isolated sandbox — no LLM calls, original project never touched.

export const REPLAY_ROOT = path.join(os.homedir(), '.chronicle', 'replay');
const sessions = globalThis.__chronicleReplay ??= new Map(); // sessionId -> {workspace, executed:Set}

// Extract executable steps from session history (FR-RP-1)
export function buildPlan(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id);
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId);

  const steps = [];
  let lastReasoning = null;
  for (const m of messages) {
    if (m.kind === 'assistant' || m.kind === 'thinking') { lastReasoning = m.text?.slice(0, 600) ?? lastReasoning; continue; }
    if (m.kind !== 'tool_use' || !m.tool_input) continue;
    let input;
    try { input = JSON.parse(m.tool_input); } catch { continue; }
    const t = m.tool_name;
    if (t === 'Write' && input.file_path) {
      steps.push({ seq: m.seq, ts: m.ts, type: 'write', file: input.file_path, content: input.content ?? '', reasoning: lastReasoning });
    } else if (t === 'Edit' && input.file_path) {
      steps.push({ seq: m.seq, ts: m.ts, type: 'edit', file: input.file_path,
        old_string: input.old_string ?? '', new_string: input.new_string ?? '',
        replace_all: !!input.replace_all, reasoning: lastReasoning });
    } else if (t === 'Bash' && input.command) {
      steps.push({ seq: m.seq, ts: m.ts, type: 'command', command: input.command, reasoning: lastReasoning });
    }
  }
  const state = sessions.get(sessionId);
  return {
    session: { id: session.id, source: session.source, started_at: session.started_at },
    projectPath: project.path,
    workspace: state?.workspace ?? defaultWorkspace(sessionId),
    started: !!state,
    executed: state ? [...state.executed] : [],
    steps: steps.map((s) => ({ ...s, content: undefined, contentLength: s.content?.length })),
  };
}

function defaultWorkspace(sessionId) {
  return path.join(REPLAY_ROOT, sessionId.slice(0, 24));
}

// FR-RP-3/4: sandbox workspace, seeded from the Git snapshot at session start.
export function startReplay(sessionId, workspace) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id);
  const ws = workspace || defaultWorkspace(sessionId);
  if (!ws.startsWith(REPLAY_ROOT) && ws !== workspace) throw new Error('Invalid workspace');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });

  let seeded = null;
  if (gitEngine.isGitRepo(project.path) && session.started_at) {
    const commit = gitEngine.commitAt(project.path, session.started_at);
    if (commit) {
      // git archive → tar extract: materialize the tree as of session start
      execFileSync('bash', ['-c',
        `git -C "${project.path}" archive ${commit.hash} | tar -x -C "${ws}"`],
        { maxBuffer: 512 * 1024 * 1024 });
      seeded = commit;
    }
  }
  sessions.set(sessionId, { workspace: ws, executed: new Set(), projectPath: project.path });
  return { ok: true, workspace: ws, seededFrom: seeded };
}

// Map an absolute path from the original project into the sandbox
function sandboxPath(state, filePath) {
  const rel = path.isAbsolute(filePath)
    ? path.relative(state.projectPath, filePath)
    : filePath;
  if (rel.startsWith('..')) throw new Error(`Path escapes project: ${filePath}`);
  return path.join(state.workspace, rel);
}

function getStep(sessionId, seq) {
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? AND seq = ?').all(sessionId, seq);
  if (!messages.length) throw new Error('Step not found');
  const m = messages[0];
  const input = JSON.parse(m.tool_input || '{}');
  return { m, input };
}

// FR-RP-2: preview the upcoming change against current sandbox state
export function previewStep(sessionId, seq) {
  const state = sessions.get(sessionId);
  if (!state) throw new Error('Replay not started');
  const { m, input } = getStep(sessionId, seq);
  if (m.tool_name === 'Write') {
    const target = sandboxPath(state, input.file_path);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    return { type: 'write', file: input.file_path, current, next: input.content ?? '' };
  }
  if (m.tool_name === 'Edit') {
    const target = sandboxPath(state, input.file_path);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    let next = null, applies = false;
    if (current != null && input.old_string && current.includes(input.old_string)) {
      applies = true;
      next = input.replace_all
        ? current.split(input.old_string).join(input.new_string ?? '')
        : current.replace(input.old_string, input.new_string ?? '');
    }
    return { type: 'edit', file: input.file_path, current, next, applies };
  }
  if (m.tool_name === 'Bash') {
    return { type: 'command', command: input.command, cwd: state.workspace };
  }
  return { type: 'unsupported' };
}

// Execute one step in the sandbox (FR-RP-6/7)
export function executeStep(sessionId, seq, { confirmCommand } = {}) {
  const state = sessions.get(sessionId);
  if (!state) throw new Error('Replay not started');
  const { m, input } = getStep(sessionId, seq);
  try {
    if (m.tool_name === 'Write') {
      const target = sandboxPath(state, input.file_path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, input.content ?? '');
      state.executed.add(seq);
      return { ok: true, result: `wrote ${path.relative(state.workspace, target)} (${(input.content ?? '').length} chars)` };
    }
    if (m.tool_name === 'Edit') {
      const target = sandboxPath(state, input.file_path);
      if (!fs.existsSync(target)) throw new Error('File missing in sandbox: ' + input.file_path);
      const current = fs.readFileSync(target, 'utf8');
      if (!input.old_string || !current.includes(input.old_string)) throw new Error('old_string not found — file state differs');
      const next = input.replace_all
        ? current.split(input.old_string).join(input.new_string ?? '')
        : current.replace(input.old_string, input.new_string ?? '');
      fs.writeFileSync(target, next);
      state.executed.add(seq);
      return { ok: true, result: `edited ${path.relative(state.workspace, target)}` };
    }
    if (m.tool_name === 'Bash') {
      // Dangerous-command handling (FR-RP-7): explicit confirmation required
      if (!confirmCommand) return { ok: false, needsConfirmation: true, command: input.command };
      const out = execFileSync('bash', ['-c', input.command], {
        cwd: state.workspace, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, HOME: state.workspace }, // soft containment
      });
      state.executed.add(seq);
      return { ok: true, result: out.slice(0, 4000) || '(no output)' };
    }
    throw new Error('Unsupported step type: ' + m.tool_name);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

export function openWorkspace(sessionId) {
  const state = sessions.get(sessionId);
  if (!state) throw new Error('Replay not started');
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [state.workspace]);
}
