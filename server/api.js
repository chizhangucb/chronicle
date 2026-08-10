import express from 'express';
import { mountImportSync } from './routes/import-sync.js';
import { mountSettings }   from './routes/settings.js';
import { mountProjects }   from './routes/projects.js';
import { mountSessions }   from './routes/sessions.js';
import { mountSearch }     from './routes/search.js';
import { mountSecurity }   from './routes/security.js';
import { mountGit }        from './routes/git.js';
import { startAutoSync }   from './autosync.js';

export const api = express();
api.use(express.json());        // MUST stay first — body parsing for all POST/PATCH

mountImportSync(api);
mountSettings(api);
mountProjects(api);
mountSessions(api);
mountSearch(api);
mountSecurity(api);
mountGit(api);

// Auto-sync starts with the server in every run mode (dev / standalone /
// Electron); watchers + timer live on globalThis so SSR reloads don't orphan
// them. No-op when the user disabled auto-sync in settings.
startAutoSync();
