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
import { mountHub }        from './routes/hub.ts';
import { mountBriefing }   from './routes/briefing.ts';
import { makeConsoleGate, mountGateRoutes, gateTokenGuard } from './gate/routes.ts';
import type { Gate } from './gate/core.ts';
import { startAutoSync }   from './autosync.ts';

declare global {
  // eslint-disable-next-line no-var
  var __chronicleGate: Gate | undefined;
}
// One gate per boot; on globalThis so Vite SSR reloads don't remint the token
// mid-session (which would 403 the open tab's cached token) — same pattern as
// server/cache.ts / server/autosync.ts.
const gate: Gate = (globalThis.__chronicleGate ??= makeConsoleGate());

export const api = express();
api.use(express.json());        // MUST stay first — body parsing for all POST/PATCH

// Gate token guard on EVERY mutating route (CHI-323 D2): the ported gate routes
// AND Chronicle's existing writes (import, sync, project/session ops, settings,
// security rules, hub config), one consistent posture. See gateTokenGuard. The
// tiered auto-approval model is CHI-329.
api.use(gateTokenGuard(gate));

mountGateRoutes(api, gate);
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
mountHub(api);
mountBriefing(api);

// Auto-sync starts with the server in every run mode (dev / standalone);
// watchers + timer live on globalThis so SSR reloads don't orphan them.
// No-op when the user disabled auto-sync in settings.
startAutoSync();
