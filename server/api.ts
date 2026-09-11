import express, { type Express } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { mountImportSync } from './routes/import-sync.ts';
import { mountSettings }   from './routes/settings.ts';
import { mountProjects }   from './routes/projects.ts';
import { mountSessions }   from './routes/sessions.ts';
import { mountSearch }     from './routes/search.ts';
import { mountSecurity }   from './routes/security.ts';
import { mountGit }        from './routes/git.ts';
import { mountInsights }   from './routes/insights.ts';
import { mountExplore }    from './routes/explore.ts';
import { mountContent }    from './routes/content.ts';
import { mountActivity }   from './routes/activity.ts';
import { mountDetectors }  from './routes/detectors.ts';
import { mountWaste }      from './routes/waste.ts';
import { mountPlanWindows } from './routes/planWindows.ts';
import { mountAsk }        from './routes/ask.ts';
import { mountDemo }       from './routes/demo.ts';
import { writeTokenGuard, mountWriteToken } from './writeToken.ts';
import { useDatabase } from './db.ts';

/**
 * Build the Express app that serves /api, reading and writing `db`.
 *
 * Nothing happens when this module is imported (issue #275, audit F13): no app,
 * no routes, and no auto-sync: the entry points start that (server/standalone.ts,
 * the Vite dev plugin). A test gets a whole API over its own temp database in
 * one line: `createApp(openDatabase(dir))`.
 *
 * One database per process, by design: the routes read the current handle
 * (server/db.ts's getDb()), so building a second app makes ITS database the
 * current one for the first app too. Chronicle serves one data folder per boot;
 * a test that wants two databases at once wants two processes.
 */
export function createApp(db: DatabaseSync): Express {
  // The routes below read the open handle through getDb(), so the database this
  // app serves is whichever one it was handed.
  useDatabase(db);
  const api = express();
  api.use(express.json());        // MUST stay first — body parsing for all POST/PATCH

  // Per-boot write token on EVERY mutating route: import, sync,
  // project/session ops, settings, security rules — one consistent posture, no
  // split. Same-origin guard, not auth; see server/writeToken.ts.
  api.use(writeTokenGuard());

  mountWriteToken(api);
  mountImportSync(api);
  mountSettings(api);
  mountProjects(api);
  mountSessions(api);
  mountSearch(api);
  mountSecurity(api);
  mountGit(api);
  mountInsights(api);
  mountExplore(api);
  mountContent(api);
  mountActivity(api);
  mountDetectors(api);
  mountWaste(api);
  mountPlanWindows(api);
  mountAsk(api);
  mountDemo(api);

  return api;
}
