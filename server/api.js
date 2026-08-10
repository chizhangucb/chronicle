import express from 'express';
import { db } from './db.js';
import * as gitEngine from './git.js';
import { startAutoSync } from './autosync.js';
import { mountImportSync } from './routes/import-sync.js';
import { mountSettings } from './routes/settings.js';
import { mountProjects } from './routes/projects.js';
import { mountSessions } from './routes/sessions.js';
import { mountSearch } from './routes/search.js';
import { mountSecurity } from './routes/security.js';

export const api = express();
api.use(express.json());

mountImportSync(api);
mountSettings(api);
mountProjects(api);
mountSessions(api);
mountSearch(api);
mountSecurity(api);

// ---- Git snapshot engine ----

function projectRepo(req, res) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.query.project);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  if (!gitEngine.isGitRepo(project.path)) { res.json({ noRepo: true }); return null; }
  return project;
}

api.get('/git/at', (req, res) => {
  const project = projectRepo(req, res);
  if (!project) return;
  res.json({ commit: gitEngine.commitAt(project.path, req.query.ts) });
});

api.get('/git/tree', (req, res) => {
  const project = projectRepo(req, res);
  if (!project) return;
  res.json({
    files: gitEngine.treeAt(project.path, req.query.commit),
    changed: gitEngine.changedFiles(project.path, req.query.commit),
  });
});

api.get('/git/file', (req, res) => {
  const project = projectRepo(req, res);
  if (!project) return;
  try {
    res.json(gitEngine.fileAt(project.path, req.query.commit, req.query.path));
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Auto-sync starts with the server in every run mode (dev / standalone /
// Electron); watchers + timer live on globalThis so SSR reloads don't orphan
// them. No-op when the user disabled auto-sync in settings.
startAutoSync();
