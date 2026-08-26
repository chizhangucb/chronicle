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
import { mountHub }        from './routes/hub.ts';
import { startAutoSync }   from './autosync.ts';

export const api = express();
api.use(express.json());        // MUST stay first — body parsing for all POST/PATCH

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
mountHub(api);

// Auto-sync starts with the server in every run mode (dev / standalone);
// watchers + timer live on globalThis so SSR reloads don't orphan them.
// No-op when the user disabled auto-sync in settings.
startAutoSync();
