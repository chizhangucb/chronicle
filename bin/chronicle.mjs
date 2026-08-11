#!/usr/bin/env node
// Chronicle launcher — `npx chronicle-cli`. Starts the local web app, opens the
// dashboard, runs in the foreground until Ctrl-C. Node built-ins only.
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Preflight: the server runs .ts natively via Node's strip-types loader. ---
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
if (pIdx !== -1 && argv[pIdx + 1]) {
  const n = Number(argv[pIdx + 1]);
  if (Number.isInteger(n) && n > 0 && n < 65536) requestedPort = n;
  else { console.error(`Invalid --port "${argv[pIdx + 1]}".`); process.exit(1); }
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

// --- Resolve the server entry, working around a Node type-stripping limit. ---
// Node refuses to strip TypeScript types for any file whose path has a
// `node_modules` segment (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, no
// override flag exists). That's exactly where `server/standalone.ts` lives once
// this package is installed via `npm install`/`npx`. Work around it by staging a
// copy of `server/` + `shared/` (plus `dist/`) outside node_modules, in a
// version-scoped OS temp dir, and importing the staged copy instead. When running
// straight from a git checkout (no node_modules segment), this is a no-op.
//
// The staged copy also needs a `node_modules` of its own so bare imports (e.g.
// `express`) still resolve — Node's resolver walks up from the importing file
// looking for `node_modules` directories, and the temp dir has none on its own.
// Symlink one in, pointing at wherever npm actually put the installed deps
// (nested `pkgRoot/node_modules`, or hoisted — the directory literally named
// `node_modules` that is pkgRoot's own parent).
function findNodeModulesDir(pkgRoot) {
  const nested = path.join(pkgRoot, 'node_modules');
  if (fs.existsSync(path.join(nested, 'express'))) return nested;
  const parent = path.dirname(pkgRoot);
  if (path.basename(parent) === 'node_modules') return parent;
  return nested;
}

function linkDir(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    fs.cpSync(target, linkPath, { recursive: true });
  }
}

function resolveServerEntry() {
  const direct = new URL('../server/standalone.ts', import.meta.url);
  if (!fileURLToPath(direct).split(path.sep).includes('node_modules')) return direct;

  const binDir = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.join(binDir, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  const stageDir = path.join(os.tmpdir(), `chronicle-cli-stage-${pkg.version}`);
  const marker = path.join(stageDir, '.staged');
  if (!fs.existsSync(marker)) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    fs.cpSync(path.join(pkgRoot, 'server'), path.join(stageDir, 'server'), { recursive: true });
    fs.cpSync(path.join(pkgRoot, 'shared'), path.join(stageDir, 'shared'), { recursive: true });
    linkDir(path.join(pkgRoot, 'dist'), path.join(stageDir, 'dist'));
    linkDir(findNodeModulesDir(pkgRoot), path.join(stageDir, 'node_modules'));
    fs.writeFileSync(marker, '');
  }
  return new URL(`file://${path.join(stageDir, 'server', 'standalone.ts')}`);
}

const port = await firstFreePort(requestedPort);
const { startServer } = await import(resolveServerEntry());
const server = await startServer(port);
const url = `http://localhost:${port}`;
console.log(`\n  Chronicle is running at ${url}`);
console.log('  Press Ctrl-C to stop.\n');
if (!noOpen) openBrowser(url);

function shutdown() { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
