import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api } from './api.js';
import { sharePage } from './shares.js';
import { mcpEndpoint } from './mcp/hub.js';

// Standalone server for the desktop shell / production: serves the built UI
// plus all endpoints without Vite. `npm run build` first.
export function startServer(port = 41730) {
  const app = express();
  const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  app.use('/api', api);
  app.use('/share', sharePage);
  app.use('/mcp', mcpEndpoint);
  app.use(express.static(dist));
  app.get(/^\/(?!api|share|mcp).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
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
