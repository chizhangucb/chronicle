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
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

// `node server/standalone.js` runs it directly (no Electron)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 41730);
  startServer(port).then(() => console.log(`Chronicle standalone on http://localhost:${port}`));
}
