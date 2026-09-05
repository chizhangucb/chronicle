import type { Express, Request, Response } from 'express';

// Demo-mode control.
//
// Entering and leaving demo cannot be done in-process: server/db.ts binds its
// handle to CHRONICLE_DATA_DIR at import time, so switching databases means
// switching processes. The CLI publishes a relaunch capability on globalThis
// (the __chronicleGate / __chronicleCache idiom) and these routes call it.
//
// Under `npm run dev` there is no CLI to relaunch, so `available` is false and
// the UI offers the command to copy instead of a button. That is why the status
// route exists at all: the affordance must never be a button that does nothing.
declare global {
  // eslint-disable-next-line no-var
  var __chronicleRelaunch: ((mode: 'demo' | 'live') => void) | undefined;
}

export function mountDemo(app: Express): void {
  app.get('/demo/status', (_req: Request, res: Response) => {
    res.json({
      demo: process.env.CHRONICLE_DEMO === '1',
      // Whether THIS process can restart itself into the other mode.
      available: typeof globalThis.__chronicleRelaunch === 'function',
    });
  });

  app.post('/demo/start', (_req: Request, res: Response) => {
    const relaunch = globalThis.__chronicleRelaunch;
    if (!relaunch) return res.status(409).json({ error: 'This Chronicle was not started by the CLI, so it cannot restart itself. Run: npx chronicle-cli --demo' });
    // Answer BEFORE relaunching: the client needs the 200 in hand so it knows
    // to start polling for the new server rather than treating the dropped
    // connection as a failure.
    res.json({ ok: true, restarting: true });
    setTimeout(() => relaunch('demo'), 50);
  });

  app.post('/demo/exit', (_req: Request, res: Response) => {
    const relaunch = globalThis.__chronicleRelaunch;
    if (!relaunch) return res.status(409).json({ error: 'This Chronicle was not started by the CLI, so it cannot restart itself.' });
    res.json({ ok: true, restarting: true });
    setTimeout(() => relaunch('live'), 50);
  });
}
