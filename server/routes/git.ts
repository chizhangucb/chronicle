import type { Express, Request, Response } from 'express';
import { db, type ProjectRow } from '../db.ts';
import * as gitEngine from '../git.ts';

export function mountGit(app: Express): void {
  // ---- Git snapshot engine ----

  function projectRepo(req: Request, res: Response): ProjectRow | null {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.query.project as string) as ProjectRow | undefined;
    if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
    if (!gitEngine.isGitRepo(project.path)) { res.json({ noRepo: true }); return null; }
    return project;
  }

  app.get('/git/at', (req: Request, res: Response) => {
    const project = projectRepo(req, res);
    if (!project) return;
    res.json({ commit: gitEngine.commitAt(project.path, req.query.ts as string) });
  });

  app.get('/git/tree', (req: Request, res: Response) => {
    const project = projectRepo(req, res);
    if (!project) return;
    res.json({
      files: gitEngine.treeAt(project.path, req.query.commit as string),
      changed: gitEngine.changedFiles(project.path, req.query.commit as string),
    });
  });

  app.get('/git/file', (req: Request, res: Response) => {
    const project = projectRepo(req, res);
    if (!project) return;
    try {
      res.json(gitEngine.fileAt(project.path, req.query.commit as string, req.query.path as string));
    } catch (err) {
      res.status(500).json({ error: String((err as Error).message || err) });
    }
  });
}
