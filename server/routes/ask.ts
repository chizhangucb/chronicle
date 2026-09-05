import type { Express, Request, Response } from 'express';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../autosync.ts';
import {
  findClaudeBin, readAskHistory, appendAskTurn, normalizeAskCostMode,
  type AskTurn,
} from '../ask.ts';

// /ask routes. The `∴ Ask` metric chat: a local claude-CLI-backed
// runner with exactly one read-only SELECT-only tool over chronicle.db. Gated,
// server-side, on THREE conditions (never the hidden sidebar entry alone): the
// Settings toggle is on, the claude CLI is present, and the console is not a
// demo seed. POST spawns the runner ASYNC (never spawnSync in the request path
// — node:sqlite has no query interrupt, so a sync run would freeze every tab).

interface AskRunState { running: boolean; startedAt: string | null; }
declare global {
  // eslint-disable-next-line no-var
  var __chronicleAskRun: AskRunState | undefined;
}
const runState: AskRunState = (globalThis.__chronicleAskRun ??= { running: false, startedAt: null });

// Outer backstop: a touch beyond the runner's own 90s claude timeout, so a wedged
// runner can't pin the in-flight guard forever.
const OUTER_TIMEOUT_MS = 120 * 1000;

export function askToggleOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return readConfig().ask === true && env.CHRONICLE_ASK !== '0';
}
function isDemo(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHRONICLE_DEMO === '1';
}

/** Runner entry: compiled JS in the published package, else the TS source in dev
 * (Node 24 type-strips it). */
function runnerEntry(): string | null {
  const candidates = [
    new URL('../../scripts/run-ask.js', import.meta.url),
    new URL('../../scripts/run-ask.ts', import.meta.url),
  ].map((u) => fileURLToPath(u));
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function mountAsk(app: Express): void {
  app.get('/ask/status', (_req: Request, res: Response) => {
    const toggleOn = askToggleOn();
    const claudePresent = !!findClaudeBin();
    const demo = isDemo();
    res.json({ enabled: toggleOn && claudePresent && !demo, toggleOn, claudePresent, demo });
  });

  app.get('/ask/history', (_req: Request, res: Response) => {
    res.json({ turns: readAskHistory() });
  });

  app.post('/ask', (req: Request, res: Response) => {
    if (isDemo()) return res.status(409).json({ error: 'demo seed, /ask is disabled', fix: 'run on a real console' });
    if (!askToggleOn()) return res.status(403).json({ error: 'Ask is off', fix: 'enable Ask in Settings' });
    if (!findClaudeBin()) return res.status(403).json({ error: 'the claude CLI was not found', fix: 'install the claude CLI and reload' });
    if (runState.running) return res.status(409).json({ error: 'a query is already running' });

    const question = String(req.body?.question ?? '').trim();
    const costMode = normalizeAskCostMode(req.body?.costMode);
    if (!question) return res.status(400).json({ error: 'question is required' });
    if (question.length > 2000) return res.status(400).json({ error: 'question is too long (max 2000 chars)' });

    const entry = runnerEntry();
    if (!entry) return res.status(500).json({ error: 'ask runner not found', fix: 'reinstall Chronicle' });

    runState.running = true;
    runState.startedAt = new Date().toISOString();
    let child;
    try {
      // detached: the runner leads its own process GROUP, so on timeout we can
      // SIGKILL the whole group (runner + claude + the MCP subprocess). A pure
      // child.kill hits only the runner PID and could orphan a heavy query
      // (node:sqlite has no interrupt, so only SIGKILL to the group stops it).
      child = spawn(process.execPath, [entry, '--question', question, '--cost-mode', costMode], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
    } catch {
      runState.running = false; runState.startedAt = null;
      return res.status(500).json({ error: 'failed to start the query run' });
    }
    const pid = child.pid;
    const killGroup = (): void => {
      try { if (pid) process.kill(-pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    let out = '', errb = '';
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { errb += d; });
    let settled = false;
    const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); runState.running = false; runState.startedAt = null; fn(); };
    const timer = setTimeout(() => { killGroup(); finish(() => res.status(504).json({ error: 'the query run timed out' })); }, OUTER_TIMEOUT_MS);

    child.on('exit', () => finish(() => {
      let turn: AskTurn | null = null;
      try {
        const last = out.trim().split('\n').filter(Boolean).pop();
        if (last) turn = JSON.parse(last) as AskTurn;
      } catch { turn = null; }
      if (!turn) return res.status(500).json({ error: 'the query run produced no answer', detail: errb.slice(0, 300) });
      appendAskTurn(turn);
      res.json({ turn });
    }));
    child.on('error', () => finish(() => res.status(500).json({ error: 'failed to start the query run' })));
  });
}
