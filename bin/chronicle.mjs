#!/usr/bin/env node
// Chronicle launcher — `npx chronicle-cli`. Starts the local web app, opens the
// dashboard, runs in the foreground until Ctrl-C. Node built-ins only.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- Preflight: the published server ships as compiled JS (dist-server/),  ---
// --- built at publish time — Node 24+ is still required for node:sqlite.   ---
const major = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(major) || major < 24) {
  console.error(`Chronicle requires Node.js 24 or newer (you have ${process.versions.node}).`);
  console.error('Install the latest Node from https://nodejs.org and re-run `npx chronicle-cli`.');
  process.exit(1);
}

// --- Args: --port <n>, --no-open ---
const argv = process.argv.slice(2);
const noOpen = argv.includes('--no-open');
let requestedPort = 41730;
const pIdx = argv.indexOf('--port');
if (pIdx !== -1) {
  const raw = argv[pIdx + 1];
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n <= 0 || n >= 65536) {
    console.error(`Invalid --port "${raw ?? '(missing)'}" — expected an integer between 1 and 65535.`);
    process.exit(1);
  }
  requestedPort = n;
}

// --- Find a free port starting at the requested one (bounded scan). ---
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function firstFreePort(start) {
  for (let p = start; p < start + 50; p++) if (await portFree(p)) return p;
  throw new Error(`No free port found in ${start}..${start + 49}`);
}

// --- Open the default browser (best-effort; never fatal). ---
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* ignore */ }
}

// The published tarball ships a compiled server at dist-server/server/standalone.js
// (built at publish time by `tsc -p tsconfig.publish.json`), so a plain import()
// works even though the file resolves under node_modules — no dev-only type
// stripping involved. The compiled server's own directory is NOT the client
// asset dir (dist/ sits at the package root, dist-server/ is a sibling), so pass
// the client dist path explicitly rather than relying on standalone.js's default.
const pkgRoot = new URL('../', import.meta.url);
const distDir = fileURLToPath(new URL('dist/', pkgRoot));

let port, server;
try {
  port = await firstFreePort(requestedPort);
  const { startServer } = await import(new URL('../dist-server/server/standalone.js', import.meta.url));
  server = await startServer(port, distDir);
} catch (err) {
  console.error(`Chronicle could not start a local server: ${err?.message ?? err}`);
  console.error('Another process may be holding the ports, or pass a different --port.');
  process.exit(1);
}
const url = `http://localhost:${port}`;
console.log(`\n  Chronicle is running at ${url}`);
console.log('  Press Ctrl-C to stop.\n');
if (!noOpen) openBrowser(url);

function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
