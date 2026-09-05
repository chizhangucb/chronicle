import express from 'express';
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
import { mountViewLog }    from './routes/viewlog.ts';
import { mountDemo }       from './routes/demo.ts';
import { writeTokenGuard, mountWriteToken } from './writeToken.ts';
import { startAutoSync }   from './autosync.ts';
import { pruneViewLog }    from './viewlog.ts';

export const api = express();
api.use(express.json());        // MUST stay first — body parsing for all POST/PATCH

// Per-boot write token on EVERY mutating route (CHI-222): import, sync,
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
mountViewLog(api);
mountDemo(api);

// Rolling 180-day retention on the view log (CHI-325 D8), once per boot.
// Pruning here rather than per write keeps a DELETE scan out of the
// navigation path; pruneViewLog swallows its own failure so a locked DB at
// this exact moment costs stale rows, never startup.
pruneViewLog();

// Auto-sync starts with the server in every run mode (dev / standalone);
// watchers + timer live on globalThis so SSR reloads don't orphan them.
// No-op when the user disabled auto-sync in settings.
startAutoSync();
