import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { api } from './api.ts';

// Standalone server for the desktop shell / production: serves the built UI
// plus all endpoints without Vite. `npm run build` first.
// `distDir` lets callers whose compiled server doesn't sit next to the client
// build (e.g. the published dist-server/ tree) point at the real client dist/.
export function startServer(port = 41730, distDir?: string): Promise<Server> {
  const app = express();
  const dist = distDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  app.use('/api', api);
  app.use(express.static(dist));
  // SPA fallback: use relative path + root form to check dot segments relative to
  // root only. Direct path.join() form fails under dot-segment install paths
  // (e.g. npx _npx/<hash>, .claude/worktrees/…) because express/send's default
  // dotfiles: 'ignore' treats dot segments as dotfiles. Root form bypasses this.
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile('index.html', { root: dist }));
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// Run directly (`node server/standalone.ts`) when invoked as the entry module.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 41730);
  startServer(port).then(() => console.log(`Chronicle standalone on http://localhost:${port}`));
}
