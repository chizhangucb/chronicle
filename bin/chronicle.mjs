#!/usr/bin/env node
// Chronicle launcher — `npx chronicle-cli`. Starts the local web app, opens the
// dashboard, runs in the foreground until Ctrl-C. Node built-ins only.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// --- Silence ONLY the node:sqlite experimental warning. ---
// The server opens the DB via node:sqlite (DatabaseSync), which emits a single
// `ExperimentalWarning: SQLite is an experimental feature…` to stderr on first
// import. In the foreground npx run that line is just noise (the desktop shell
// used to hide it). Filter that one warning surgically; every other warning
// still prints. NODE_NO_WARNINGS would blanket-silence, so we don't use it.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const type = rest[0] && typeof rest[0] === 'object' ? rest[0].type : rest[0];
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  return emitWarning(warning, ...rest);
};

// --- Preflight: the published server ships as compiled JS (dist-server/),  ---
// --- built at publish time — Node 24+ is still required for node:sqlite.   ---
const major = Number(process.versions.node.split('.')[0]);
if (Number.isNaN(major) || major < 24) {
  console.error(`Chronicle requires Node.js 24 or newer (you have ${process.versions.node}).`);
  console.error('Install the latest Node from https://nodejs.org and re-run `npx chronicle-cli`.');
  process.exit(1);
}

// --- Setup affordance: `chronicle hub set|status|clear [path]` (CHI-323 D3). ---
// Points Chronicle at a nisse-format hub before first launch. Reads/writes
// ~/.chronicle/config.json with a MERGE (never a fresh write) so it can't clobber
// the autosync / noise-gate keys that share the file — the plain-JS twin of the
// server's writeConfig({...readConfig(), hubRoot}). Kept in built-ins so it runs
// without the compiled server.
function hubConfigPath() {
  const dir = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');
  return { dir, file: path.join(dir, 'config.json') };
}
function readHubConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function isNisseHub(root) {
  try {
    return fs.statSync(path.join(root, 'operations.md')).isFile()
      && fs.statSync(path.join(root, 'records')).isDirectory()
      && fs.statSync(path.join(root, 'governance')).isDirectory();
  } catch { return false; }
}
function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
if (process.argv[2] === 'hub') {
  const sub = process.argv[3];
  const { dir, file } = hubConfigPath();
  const cfg = readHubConfig(file);
  if (sub === 'status') {
    const envHub = process.env.CHRONICLE_HUB || process.env.AIOS_HUB;
    const configured = envHub || cfg.hubRoot;
    if (process.env.CHRONICLE_DEMO === '1') console.log('Hub: demo mode (CHRONICLE_DEMO=1) — synthetic data.');
    else if (configured && isNisseHub(path.resolve(expandTilde(configured)))) console.log(`Hub: ${path.resolve(expandTilde(configured))} (nisse-format, live).`);
    else if (configured) console.log(`Hub: ${configured} is set but is not a nisse-format hub (need operations.md + records/ + governance/).`);
    else console.log('Hub: none configured. Run `chronicle hub set <path>` to connect one.');
    process.exit(0);
  }
  if (sub === 'set') {
    const raw = process.argv[4];
    if (!raw) { console.error('Usage: chronicle hub set <path-to-nisse-hub>'); process.exit(1); }
    const root = path.resolve(expandTilde(raw));
    if (!isNisseHub(root)) {
      console.error(`${root} is not a nisse-format hub (need operations.md + records/ + governance/).`);
      process.exit(1);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...cfg, hubRoot: root }, null, 2));
    console.log(`Hub set to ${root}. Ops panels will light up on next launch.`);
    process.exit(0);
  }
  if (sub === 'clear') {
    const { hubRoot, ...rest } = cfg;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rest, null, 2));
    console.log('Hub cleared. Ops panels hidden until a hub is set.');
    process.exit(0);
  }
  console.error('Usage: chronicle hub <set <path> | status | clear>');
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
