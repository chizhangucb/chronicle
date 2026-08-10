import { db } from '../db.ts';
import * as gitEngine from '../git.ts';

export function mountGit(app) {
  // ---- Git snapshot engine ----

  function projectRepo(req, res) {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.query.project);
    if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
    if (!gitEngine.isGitRepo(project.path)) { res.json({ noRepo: true }); return null; }
    return project;
  }

  app.get('/git/at', (req, res) => {
    const project = projectRepo(req, res);
    if (!project) return;
    res.json({ commit: gitEngine.commitAt(project.path, req.query.ts) });
  });

  app.get('/git/tree', (req, res) => {
    const project = projectRepo(req, res);
    if (!project) return;
    res.json({
      files: gitEngine.treeAt(project.path, req.query.commit),
      changed: gitEngine.changedFiles(project.path, req.query.commit),
    });
  });

  app.get('/git/file', (req, res) => {
    const project = projectRepo(req, res);
    if (!project) return;
    try {
      res.json(gitEngine.fileAt(project.path, req.query.commit, req.query.path));
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
}
