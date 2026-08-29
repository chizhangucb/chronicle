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
    if (process.env.CHRONICLE_DEMO === '1') console.log('Hub: demo mode (CHRONICLE_DEMO=1) - synthetic data.');
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
// --demo (CHI-325 D9): the whole product on synthetic data, for a zero-data
// user. CHRONICLE_DEMO=1 keeps working; the flag is the discoverable form.
const demo = argv.includes('--demo') || process.env.CHRONICLE_DEMO === '1';
// --app (CHI-325 D10): a dedicated browser window (no tab strip, no address
// bar) rather than a tab. The defer-with-bridge half of the desktop-shell
// decision; the real shell is its own ticket.
const appWindow = argv.includes('--app');
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

// --- `--app`: a dedicated window via Chromium's --app= (CHI-325 D10). ---
// Falls back to a normal tab with a one-line note rather than failing: the
// dedicated window is a nicety, and not opening the app at all would not be.
const APP_BROWSERS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};
function openAppWindow(url) {
  const candidates = APP_BROWSERS[process.platform] ?? [];
  const found = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!found) {
    console.log('  (--app needs a Chromium-based browser; opening a normal tab instead.)');
    openBrowser(url);
    return;
  }
  try {
    spawn(found, [`--app=${url}`], { stdio: 'ignore', detached: true }).unref();
  } catch {
    openBrowser(url);
  }
}

// The published tarball ships a compiled server at dist-server/server/standalone.js
// (built at publish time by `tsc -p tsconfig.publish.json`), so a plain import()
// works even though the file resolves under node_modules — no dev-only type
// stripping involved. The compiled server's own directory is NOT the client
// asset dir (dist/ sits at the package root, dist-server/ is a sibling), so pass
// the client dist path explicitly rather than relying on standalone.js's default.
const pkgRoot = new URL('../', import.meta.url);
const distDir = fileURLToPath(new URL('dist/', pkgRoot));

// --- Demo mode (CHI-325 3c): point the data dir at a throwaway demo DB and
// --- seed it, BEFORE importing the server (server/db.ts binds its handle to
// --- CHRONICLE_DATA_DIR at import time, so the order is load-bearing).
// --- ~/.chronicle is never opened, migrated, or written in demo.
if (demo) {
  process.env.CHRONICLE_DEMO = '1';
  const { demoDataDir, seedDemo, demoIsSeeded } = await import(new URL('../dist-server/server/demo/seed.js', import.meta.url));
  const dir = demoDataDir();
  process.env.CHRONICLE_DATA_DIR = dir;
  if (!demoIsSeeded(dir)) console.log('  Building the demo console (first run today)…');
  try {
    await seedDemo(dir, (m) => console.log(`  ${m}`));
  } catch (err) {
    console.error(`Chronicle could not build the demo data: ${err?.message ?? err}`);
    process.exit(1);
  }
}

let port, server;
try {
  port = await firstFreePort(requestedPort);
  const { startServer } = await import(new URL('../dist-server/server/standalone.js', import.meta.url));
  // Relaunch capability (CHI-325 3c). Published on globalThis rather than
  // passed into startServer, because `api` is a module-level singleton whose
  // routes are mounted at import time: by the time startServer runs there is
  // nothing left to inject into. Same idiom as __chronicleGate/__chronicleCache.
  globalThis.__chronicleRelaunch = (mode) => relaunch(mode, port);
  server = await startServer(port, distDir);
} catch (err) {
  console.error(`Chronicle could not start a local server: ${err?.message ?? err}`);
  console.error('Another process may be holding the ports, or pass a different --port.');
  process.exit(1);
}
const url = `http://localhost:${port}`;
console.log(`\n  Chronicle is running at ${url}`);
console.log('  Press Ctrl-C to stop.\n');
if (!noOpen) (appWindow ? openAppWindow : openBrowser)(url);

function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/**
 * Restart this process into (or out of) demo mode, on the SAME port.
 *
 * Three things here are load-bearing, each learned the hard way:
 *  - closeAllConnections(): the SPA holds keep-alives and possibly an open
 *    EventSource, so a plain server.close() waits for them and never fires.
 *  - The forced exit timer: the same reason the SIGINT path above has one.
 *  - `--port <same port>` passed to the child: without it the child's
 *    firstFreePort scan finds the parent's port still in TIME_WAIT, moves to
 *    port+1, and the browser (polling the old port for the server to come
 *    back) never reconnects.
 */
function relaunch(mode, currentPort) {
  const args = process.argv.slice(2).filter((a, i, all) =>
    a !== '--demo' && a !== '--no-open' && a !== '--app'
    && !(a === '--port') && !(all[i - 1] === '--port'));
  args.push('--port', String(currentPort), '--no-open');
  if (mode === 'demo') args.push('--demo');

  const env = { ...process.env };
  if (mode === 'demo') env.CHRONICLE_DEMO = '1';
  else { delete env.CHRONICLE_DEMO; delete env.CHRONICLE_DATA_DIR; }

  // close() and the fallback timer can both fire; the child must be spawned
  // exactly once or the port fight resumes between two of our own processes.
  let spawned = false;
  const spawnChild = () => {
    if (spawned) return;
    spawned = true;
    spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      env, stdio: 'inherit', detached: false,
    });
    process.exit(0);
  };

  try { server.closeAllConnections?.(); } catch { /* older node */ }
  server.close(spawnChild);
  setTimeout(spawnChild, 800);
}
