#!/usr/bin/env node
// scripts/walk-seed.mjs — a vendor-varied release walk on a THROWAWAY DB.
//
// The normal `npm run walk` runs against the maintainer's real ~/.chronicle DB,
// which is nearly all `claude-*` — so the Spend tab's [project|provider] toggle,
// and the median-session dash show ~one vendor. This launcher seeds a throwaway
// temp DB with the vendor-varied fixture set (test/fixtures/walk-vendors.mjs —
// anthropic / openai / google across three projects), starts a standalone server
// against it, then runs the standard walk against it.
//
// It NEVER touches the operator's real DB: everything lands in an mkdtemp
// CHRONICLE_DATA_DIR that is removed on exit. Seeding goes through the real
// import API (scan -> import), never a direct DB write — same seam as the E2E
// harness (test/e2e/helpers.ts launchSeeded / harness.ts seedDataDir).
//
// Usage:
//   node scripts/walk-seed.mjs                 # seed + walk -> /tmp/chronicle-walk-seeded/
//   node scripts/walk-seed.mjs --out DIR        # custom output dir
//   node scripts/walk-seed.mjs --serve          # seed + keep the server up, print the URL (Ctrl+C to stop)
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeMiniSession } from '../test/fixtures/gen-mini-session.mjs';
import { walkVendorSessions, WALK_VENDOR_MODELS } from '../test/fixtures/walk-vendors.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become ready at ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function ensureClientBuilt() {
  if (fs.existsSync(path.join(REPO_ROOT, 'dist', 'index.html'))) return;
  console.log('[walk-seed] dist/ missing — building the client (npm run build)…');
  const status = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' }).status ?? 1;
  if (status !== 0) throw new Error('client build failed');
}

async function main() {
  const { values } = parseArgs({ options: {
    out: { type: 'string', default: '/tmp/chronicle-walk-seeded/' },
    serve: { type: 'boolean', default: false },
  } });

  ensureClientBuilt();

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-walk-fixture-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-walk-data-'));
  const specs = walkVendorSessions(Date.now());
  for (const s of specs) writeMiniSession(fixtureDir, s);
  console.log(`[walk-seed] generated ${specs.length} sessions across ${WALK_VENDOR_MODELS.length} models: ${WALK_VENDOR_MODELS.join(', ')}`);

  const port = await findFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'standalone.ts')], {
    cwd: REPO_ROOT,
    env: { ...process.env, CHRONICLE_DATA_DIR: dataDir, CHRONICLE_E2E: '1', CHRONICLE_DEMO: '1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  proc.stdout?.on('data', (d) => { serverLog += d.toString(); });
  proc.stderr?.on('data', (d) => { serverLog += d.toString(); });

  let stopped = false;
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    try { if (proc.pid) process.kill(proc.pid); } catch { /* gone */ }
    for (const dir of [fixtureDir, dataDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    await waitForServer(`${baseURL}/api/settings`);

    // Seed through the real import API (scan -> import), guarded by the boot token.
    const scanRes = await fetch(`${baseURL}/api/scan?dir=${encodeURIComponent(fixtureDir)}`);
    if (!scanRes.ok) throw new Error(`scan failed (${scanRes.status}): ${await scanRes.text()}`);
    const scan = await scanRes.json();
    const projects = scan['claude-code'] ?? [];
    const byId = new Map();
    for (const p of projects) for (const s of p.sessions ?? []) byId.set(s.id, { logDir: p.logDir, file: s.file });
    const missing = specs.filter((s) => !byId.has(s.sessionId)).map((s) => s.sessionId);
    if (missing.length) throw new Error(`seeded sessions missing from scan: ${missing.join(', ')}`);

    const writeToken = (await (await fetch(`${baseURL}/api/write-token`)).json()).token;
    // One import per logDir (sessions across projects have different logDirs).
    const byDir = new Map();
    for (const s of specs) {
      const { logDir, file } = byId.get(s.sessionId);
      if (!byDir.has(logDir)) byDir.set(logDir, []);
      byDir.get(logDir).push(file);
    }
    let imported = 0;
    for (const [logDir, files] of byDir) {
      const res = await fetch(`${baseURL}/api/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chronicle-write-token': writeToken },
        body: JSON.stringify({ source: 'claude-code', logDir, files }),
      });
      if (!res.ok) throw new Error(`import failed (${res.status}): ${await res.text()}`);
      imported += (await res.json()).imported ?? 0;
    }
    if (imported < specs.length) throw new Error(`imported ${imported}, expected ${specs.length}\n${serverLog}`);
    console.log(`[walk-seed] imported ${imported} sessions into a throwaway DB`);

    if (values.serve) {
      console.log(`\n[walk-seed] server up: ${baseURL}`);
      console.log(`[walk-seed] run:  npm run walk -- --base ${baseURL} --out <dir>`);
      console.log('[walk-seed] Ctrl+C to stop (temp DB is removed on exit).\n');
      await new Promise(() => {}); // keep alive until SIGINT
      return;
    }

    // Run the standard walk against the seeded server.
    const code = await new Promise((resolve) => {
      const w = spawn(process.execPath, [path.join(REPO_ROOT, 'test', 'e2e', 'walk.mjs'), '--base', baseURL, '--out', values.out], {
        cwd: REPO_ROOT, stdio: 'inherit',
      });
      w.on('exit', (c) => resolve(c ?? 1));
    });
    console.log(`[walk-seed] walk complete -> ${values.out} (exit ${code})`);
    cleanup();
    process.exit(code);
  } catch (err) {
    console.error(`[walk-seed] ${err instanceof Error ? err.message : String(err)}`);
    cleanup();
    process.exit(1);
  }
}

main();
