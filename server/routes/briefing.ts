import type { Express, Request, Response } from 'express';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  readBriefingFile, readBriefingState, writeBriefingState, withDemoStates,
  applyCardAction, resolveCards, followThrough, CARD_ACTIONS, type CardAction,
} from '../briefing.ts';
import { getHubAdapter } from '../hub/adapter.ts';

// Briefing routes (CHI-323 3d). The card FILE is written only by the run; the
// STATE file only by these action routes (the grandfathered two-file split, so a
// run can never clobber a "done"). Run-now spawns the headless runner detached.

interface BriefingRunState {
  running: boolean;
  startedAt: string | null;
  lastResult: { ok: boolean; code: number | null; at: string } | null;
}
declare global {
  // eslint-disable-next-line no-var
  var __chronicleBriefingRun: BriefingRunState | undefined;
}
const runState: BriefingRunState = (globalThis.__chronicleBriefingRun ??= { running: false, startedAt: null, lastResult: null });

/** Runner entry: the compiled JS in the published package, else the TS source in
 * dev (Node 24 type-strips it). */
function runnerEntry(): string | null {
  const here = fileURLToPath(new URL('.', import.meta.url)); // server/routes/ (or dist-server/server/routes/)
  const candidates = [
    new URL('../../scripts/run-briefing.js', import.meta.url), // dist-server/scripts/run-briefing.js
    new URL('../../scripts/run-briefing.ts', import.meta.url), // dev: scripts/run-briefing.ts
  ].map((u) => fileURLToPath(u));
  void here;
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function mountBriefing(app: Express): void {
  app.get('/briefing', async (_req: Request, res: Response) => {
    const now = new Date();
    const file = await readBriefingFile(process.env, now);
    const state = withDemoStates(file, await readBriefingState());
    const cards = resolveCards(file, state, now);
    res.json({ generatedAt: file.generatedAt, cadence: file.cadence, cards, followThrough: followThrough(cards) });
  });

  app.post('/briefing/action', async (req: Request, res: Response) => {
    const cardId = String(req.body?.cardId ?? '');
    const action = String(req.body?.action ?? '') as CardAction;
    if (!cardId || !CARD_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `action must be one of ${CARD_ACTIONS.join(', ')} with a cardId` });
    }
    const now = new Date();
    const next = applyCardAction(await readBriefingState(), cardId, action, now);
    await writeBriefingState(next);
    const file = await readBriefingFile(process.env, now);
    const merged = withDemoStates(file, next);
    const cards = resolveCards(file, merged, now);
    res.json({ cards, followThrough: followThrough(cards) });
  });

  app.get('/briefing/run-status', (_req: Request, res: Response) => res.json(runState));

  app.post('/briefing/run', (_req: Request, res: Response) => {
    if (getHubAdapter().status().mode === 'demo') {
      return res.status(409).json({ error: 'demo seed, briefing run disabled', fix: 'run on a real console' });
    }
    if (runState.running) return res.status(409).json({ error: 'a briefing run is already in progress' });
    const entry = runnerEntry();
    if (!entry) return res.status(500).json({ error: 'briefing runner not found', fix: 'reinstall Chronicle' });
    runState.running = true;
    runState.startedAt = new Date().toISOString();
    const child = spawn(process.execPath, [entry, '--force'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: process.env, stdio: 'ignore', detached: false,
    });
    child.on('exit', (code) => {
      runState.running = false;
      runState.lastResult = { ok: code === 0, code, at: new Date().toISOString() };
    });
    child.on('error', () => {
      runState.running = false;
      runState.lastResult = { ok: false, code: null, at: new Date().toISOString() };
    });
    res.json({ started: true });
  });
}
