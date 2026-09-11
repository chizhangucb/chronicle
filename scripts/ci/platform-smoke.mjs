#!/usr/bin/env node
//
// Platform smoke (issue #200): does the PUBLISHED package launch and serve a
// usable app on this OS?
//
// Chronicle is developed on macOS and every CI job before this one ran on
// ubuntu-latest against the repo checkout. Nothing exercised what an operator
// actually runs (`npx chronicle-cli`), and nothing ran on Windows at all.
// This script is the assertion half of .github/workflows/platform-smoke.yml:
// point it at an INSTALLED package directory (the unpacked `npm pack` tarball)
// and it drives the real launcher four ways, per ADR 0008 and ADR 0009:
//
//   1. launch        the Node-24 preflight passes and the server answers
//   2. port scan     with 41730 taken, the launcher moves up and says so
//   3. data folder   <home>/.chronicle (or $CHRONICLE_DATA_DIR), nothing else
//   4. discovery     GET /api/scan finds a planted transcript, POST /api/import
//                    lands it, and the write token is what lets it
//
// Usage: node scripts/ci/platform-smoke.mjs --package-dir <installed pkg dir>
//
// Everything it decides for itself (the banner parse, the expected data dir,
// the stray-write sweep, the transcript it plants) is exported and pinned by
// test/platform-smoke.test.mjs. Cross-platform by construction: no shell, no
// POSIX-only paths, no signals beyond kill().
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Exported for test/platform-smoke.test.mjs, which drives each of these
// directly: DEFAULT_PORT and APP_DATA_DIRS are the constants the run holds the
// launcher to, parseLaunchUrl reads the port out of the banner,
// expectedDataDir / strayHomeEntries / appDataEntries are the ADR 0008 sweep,
// and writeClaudeTranscript plants the transcript the discovery check goes
// looking for. The end-to-end run needs an installed tarball and a CI runner,
// so these exports ARE the seam `npm test` can reach.

// The port bin/chronicle.mjs starts its upward probe at. Held here rather than
// read from the launcher, because a silent change to it should fail the smoke
// rather than be followed by it: `checkLaunch` asserts the launcher's own
// `--help` still documents this number, so the copy cannot drift unnoticed.
export const DEFAULT_PORT = 41730;

// What a temp home is allowed to contain after a run: Chronicle's own data
// folder, and the source transcripts it was pointed at (read-only, ADR 0008).
// `AppData` is there because the run CREATES it: Windows programs that write
// outside the data folder write there, so the sweep points %APPDATA% and
// %LOCALAPPDATA% inside the temp home and then asserts both stayed empty.
const ALLOWED_HOME_ENTRIES = new Set(['.chronicle', '.claude', 'AppData']);

// Where homeEnv() sends the two Windows application-data roots, relative to
// the temp home. Empty after a run, or ADR 0008 is broken on Windows.
export const APP_DATA_DIRS = [
  path.join('AppData', 'Roaming'),
  path.join('AppData', 'Local'),
];

/**
 * The URL the launcher printed, and the port it carries.
 *
 * @param {string} output - everything the launcher has written to stdout so far.
 * @returns {{ url: string, port: number } | null} null while it has not started.
 */
export function parseLaunchUrl(output) {
  // The last banner wins: a relaunch prints a second one.
  const matches = [...output.matchAll(/Chronicle is running at (http:\/\/localhost:(\d+))/g)];
  const last = matches[matches.length - 1];
  return last ? { url: last[1], port: Number(last[2]) } : null;
}

/**
 * Where ADR 0008 says Chronicle's data folder is for this environment.
 *
 * @param {string} home - the home directory the process runs with.
 * @param {Record<string, string | undefined>} env - its environment.
 * @returns {string} the only directory Chronicle may write to.
 */
export function expectedDataDir(home, env) {
  const override = env.CHRONICLE_DATA_DIR;
  return override ? override : path.join(home, '.chronicle');
}

/**
 * Top-level entries of `home` that Chronicle had no business creating.
 *
 * @param {string} home - a throwaway home directory a run was pointed at.
 * @param {Set<string> | string[]} [allowed] - what this particular home was
 *   allowed to end up with. Defaults to the full set; a home that was never
 *   seeded with transcripts passes the tighter set, so Chronicle CREATING a
 *   `~/.claude` (rather than reading one) still reads as a stray.
 * @returns {string[]} the offending names, empty when the run stayed in its folder.
 */
export function strayHomeEntries(home, allowed = ALLOWED_HOME_ENTRIES) {
  const allow = allowed instanceof Set ? allowed : new Set(allowed);
  return fs.readdirSync(home).filter((name) => !allow.has(name));
}

/**
 * Anything written under the run's %APPDATA% / %LOCALAPPDATA%.
 *
 * The POSIX sweep above would miss a Windows-only write, since nothing on
 * Windows puts application data in the home directory itself.
 *
 * @param {string} home - the throwaway home the run was pointed at.
 * @returns {string[]} paths relative to `home`, empty when nothing was written.
 */
export function appDataEntries(home) {
  const found = [];
  for (const rel of APP_DATA_DIRS) {
    const dir = path.join(home, rel);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) found.push(path.join(rel, name));
  }
  return found;
}

// A fixed, deterministic Claude Code session: one user prompt, one assistant
// turn with usage, one tool_use/tool_result pair. Small on purpose: the smoke
// proves discovery and import work on this OS, not that the parser is right
// (test/parsers/ owns that).
const FIXTURE_CWD = '/tmp/chronicle-platform-smoke';
const FIXTURE_SESSION_ID = 'platform-smoke-session';
const FIXTURE_LINES = [
  { type: 'summary', summary: 'Platform smoke session' },
  {
    type: 'user', sessionId: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, uuid: 'u1',
    timestamp: '2026-09-01T10:00:00.000Z',
    message: { role: 'user', content: 'Check that the package runs here' },
  },
  {
    type: 'assistant', sessionId: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, uuid: 'a1',
    timestamp: '2026-09-01T10:00:05.000Z',
    message: {
      model: 'claude-fable-5',
      usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 900 },
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }],
    },
  },
  {
    type: 'user', sessionId: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, uuid: 'u2',
    timestamp: '2026-09-01T10:00:09.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '# Chronicle' }] },
  },
  {
    type: 'assistant', sessionId: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD, uuid: 'a2',
    timestamp: '2026-09-01T10:00:14.000Z',
    message: {
      model: 'claude-fable-5',
      usage: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 1200 },
      content: [{ type: 'text', text: 'The package launches on this platform.' }],
    },
  },
];

/**
 * Plant one Claude Code transcript where the source discovery looks for it.
 *
 * @param {string} home - the temp home the launcher will run with.
 * @returns {{ file: string, logDir: string, sessionId: string, cwd: string }}
 */
export function writeClaudeTranscript(home) {
  // Claude Code names a project dir after its cwd with the separators munged,
  // which is the layout the scan walks.
  const logDir = path.join(home, '.claude', 'projects', FIXTURE_CWD.replace(/\//g, '-'));
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `${FIXTURE_SESSION_ID}.jsonl`);
  fs.writeFileSync(file, FIXTURE_LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { file, logDir, sessionId: FIXTURE_SESSION_ID, cwd: FIXTURE_CWD };
}

// ─────────────────────────────────────────────────────────────────────────────
// The run itself

const passed = [];
function pass(what) { passed.push(what); console.log(`  ok  ${what}`); }
function check(condition, what, detail) {
  if (!condition) throw new Error(`FAILED: ${what}${detail ? `\n       ${detail}` : ''}`);
  pass(what);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hold `port` open so the launcher has to scan past it. */
function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

/** A free port to run a check on, chosen by the OS. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start the installed launcher and wait for its banner.
 *
 * @returns {Promise<{ url: string, port: number, stop: () => Promise<void>, output: () => string }>}
 */
export async function launch(packageDir, args, env) {
  const bin = path.join(packageDir, 'bin', 'chronicle.mjs');
  if (!fs.existsSync(bin)) throw new Error(`No launcher at ${bin}: is the tarball installed?`);
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  let exited = null;
  child.on('exit', (code) => { exited = code ?? 0; });

  const deadline = Date.now() + 120_000;
  let started = null;
  while (!started && Date.now() < deadline) {
    started = parseLaunchUrl(out);
    if (!started && exited !== null) {
      throw new Error(`the launcher exited with ${exited} before it started\n--- output ---\n${out}`);
    }
    if (!started) await sleep(250);
  }
  if (!started) throw new Error(`the launcher never printed its URL\n--- output ---\n${out}`);

  const stop = async () => {
    if (exited !== null) return;
    child.kill();
    for (let i = 0; i < 40 && exited === null; i++) await sleep(100);
    // Windows has no SIGKILL; kill() there is already a terminate.
    if (exited === null) child.kill('SIGKILL');
    await sleep(250);
  };
  return { ...started, stop, output: () => out };
}

/** Poll an endpoint until it answers, so a slow first boot is not a failure. */
export async function waitFor(url, init) {
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      last = `HTTP ${res.status}`;
    } catch (err) { last = String(err?.message ?? err); }
    await sleep(250);
  }
  throw new Error(`${url} never answered (${last})`);
}

export function tempHome(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `chronicle-${label}-`));
  return fs.realpathSync(home);
}

/** The environment a launch runs in: a throwaway home on every platform. */
export function homeEnv(home, extra = {}) {
  for (const rel of APP_DATA_DIRS) fs.mkdirSync(path.join(home, rel), { recursive: true });
  return {
    ...process.env,
    HOME: home,            // os.homedir() on POSIX
    USERPROFILE: home,     // os.homedir() on Windows
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
    // Windows application data, redirected so a write there is visible as one.
    APPDATA: path.join(home, APP_DATA_DIRS[0]),
    LOCALAPPDATA: path.join(home, APP_DATA_DIRS[1]),
    CHRONICLE_DATA_DIR: undefined,
    CHRONICLE_DEMO: undefined,
    ...extra,
  };
}

/**
 * Run `fn` against a freshly launched app in its own throwaway home.
 *
 * Every check needs the same scaffold (a temp home, a port nothing else holds,
 * a launch, and a stop that runs even when an assertion throws), so it lives
 * here once.
 *
 * @param {string} packageDir - the installed package under test.
 * @param {string} label - names the temp home, so a failed run is greppable.
 * @param {object} opts
 * @param {string[]} [opts.args] - launcher flags beyond `--no-open --port`.
 * @param {Record<string, string>} [opts.env] - environment on top of the temp home.
 * @param {number} [opts.port] - a fixed port, or omit to let the launcher probe.
 * @param {string} [opts.home] - an existing temp home (one already seeded with
 *   transcripts), or omit for a fresh empty one.
 */
async function withApp(packageDir, label, { args = [], env = {}, port, home = tempHome(label) } = {}, fn) {
  const flags = ['--no-open', ...args];
  if (port !== undefined) flags.push('--port', String(port));
  const app = await launch(packageDir, flags, homeEnv(home, env));
  try {
    return await fn({ app, home });
  } finally {
    await app.stop();
  }
}

/** Run the launcher once for its output, with no server left behind. */
async function launcherOutput(packageDir, args) {
  const bin = path.join(packageDir, 'bin', 'chronicle.mjs');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.once('error', reject);
    child.once('exit', () => resolve(out));
  });
}

// ---- 1. Launch: the preflight passes and the server answers on its port. ----
async function checkLaunch(packageDir) {
  const help = await launcherOutput(packageDir, ['--help']);
  check(
    help.includes(`default ${DEFAULT_PORT}`),
    `the launcher still documents ${DEFAULT_PORT} as its default port`,
    `--help said: ${help.trim().split('\n').find((l) => l.includes('--port')) ?? '(nothing about --port)'}`,
  );
  const port = await freePort();
  return withApp(packageDir, 'launch', { port }, async ({ app }) => {
    check(app.port === port, `the launcher honours --port (${port})`);
    check(!/requires Node\.js 24/.test(app.output()), `the Node ${process.versions.node} preflight passes`);
    const res = await waitFor(`${app.url}/api/write-token`);
    const { token } = await res.json();
    check(typeof token === 'string' && token.length > 0, 'the API answers on the port it printed');
    const page = await waitFor(app.url);
    const html = await page.text();
    check(/<div id="root">/.test(html), 'the app shell is served, not just the API');
  });
}

// ---- 2. Port scan: 41730 taken, the launcher moves up and prints the port. --
async function checkPortScan(packageDir) {
  let blocker;
  try {
    blocker = await occupyPort(DEFAULT_PORT);
  } catch (err) {
    throw new Error(`could not occupy ${DEFAULT_PORT} to test the scan: ${err?.message ?? err}`);
  }
  try {
    // No --port, so the launcher runs its own upward probe from the default.
    await withApp(packageDir, 'portscan', {}, async ({ app }) => {
      check(
        app.port > DEFAULT_PORT,
        `with ${DEFAULT_PORT} held, the launcher scanned up to ${app.port}`,
        `printed: ${app.url}`,
      );
      check(app.url.endsWith(`:${app.port}`), 'the URL it printed carries the port it moved to');
      await waitFor(`${app.url}/api/write-token`);
      pass(`the server answers on ${app.port}, not ${DEFAULT_PORT}`);
    });
  } finally {
    await new Promise((r) => blocker.close(r));
  }
}

// ---- 3. Data folder: <home>/.chronicle, $CHRONICLE_DATA_DIR, nothing else. --
async function checkDataFolder(packageDir) {
  await withApp(packageDir, 'datafolder', { port: await freePort() }, async ({ app, home }) => {
    await waitFor(`${app.url}/api/projects`);
    const dataDir = expectedDataDir(home, {});
    check(fs.existsSync(dataDir), 'the data folder is created at <home>/.chronicle', dataDir);
    check(
      fs.readdirSync(dataDir).some((f) => f.startsWith('chronicle.db')),
      'the database lives in the data folder',
      `saw: ${fs.readdirSync(dataDir).join(', ')}`,
    );
    // Nothing planted this home with source logs, so only Chronicle's own
    // data folder and the harness-created AppData roots belong here.
    const strays = strayHomeEntries(home, ['.chronicle', 'AppData']);
    check(strays.length === 0, 'nothing is written outside the data folder (ADR 0008)', `strays: ${strays.join(', ')}`);
    const appData = appDataEntries(home);
    check(appData.length === 0, 'nothing is written to %APPDATA% or %LOCALAPPDATA% either',
      `wrote: ${appData.join(', ')}`);
  });

  // The override, on the same rules.
  const custom = path.join(tempHome('custom'), 'nested-data');
  await withApp(
    packageDir, 'datadir', { port: await freePort(), env: { CHRONICLE_DATA_DIR: custom } },
    async ({ app, home }) => {
      await waitFor(`${app.url}/api/projects`);
      check(fs.existsSync(custom), '$CHRONICLE_DATA_DIR is where the data folder goes', custom);
      check(
        !fs.existsSync(path.join(home, '.chronicle')),
        'with $CHRONICLE_DATA_DIR set, <home>/.chronicle is never created',
      );
    },
  );
}

// ---- 4. Source discovery: scan finds the transcript, import lands it. ------
async function checkSourceDiscovery(packageDir) {
  const port = await freePort();
  // The transcript has to exist before the launch: the scan reads the home
  // directory the server was started with.
  const home = tempHome('discovery');
  const planted = writeClaudeTranscript(home);
  await withApp(packageDir, 'discovery', { port, home }, async ({ app }) => {
    const scan = await (await waitFor(`${app.url}/api/scan`)).json();
    const found = (scan['claude-code'] ?? []).find((p) => p.physicalPath === planted.cwd);
    check(!!found, 'GET /api/scan finds the planted Claude Code transcript', `saw: ${JSON.stringify(scan['claude-code'] ?? [])}`);
    check(found.sessionCount === 1, 'the scan lists the session in it');

    // ADR 0009: a mutation without the per-boot token is refused.
    const unauthorized = await fetch(`${app.url}/api/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(found),
    });
    check(unauthorized.status === 403, 'POST /api/import without the write token is refused (ADR 0009)',
      `got HTTP ${unauthorized.status}`);

    const { token } = await (await waitFor(`${app.url}/api/write-token`)).json();
    const res = await fetch(`${app.url}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chronicle-write-token': token },
      body: JSON.stringify(found),
    });
    const body = await res.json();
    check(res.ok && body.imported === 1, 'POST /api/import lands the session with the write token',
      `HTTP ${res.status}: ${JSON.stringify(body)}`);

    // The session is in the database, not just reported as imported.
    const resolve = await fetch(`${app.url}/api/sessions/${planted.sessionId}/resolve`);
    const resolved = await resolve.json();
    check(resolve.ok && resolved.id === planted.sessionId,
      'the imported session is in the database and resolvable',
      `HTTP ${resolve.status}: ${JSON.stringify(resolved)}`);

    const messages = await (await waitFor(`${app.url}/api/sessions/${planted.sessionId}/messages`)).json();
    check((messages.messages ?? []).length >= 4, 'its messages came with it',
      `saw ${(messages.messages ?? []).length}`);
  });
}

async function main(argv) {
  const i = argv.indexOf('--package-dir');
  const packageDir = i === -1 ? null : argv[i + 1];
  if (!packageDir) {
    console.error('Usage: node scripts/ci/platform-smoke.mjs --package-dir <installed package dir>');
    process.exit(2);
  }
  const resolved = path.resolve(packageDir);
  console.log(`Platform smoke on ${process.platform} (${os.arch()}), Node ${process.versions.node}`);
  console.log(`Package under test: ${resolved}\n`);

  const checks = [
    ['launch', checkLaunch],
    ['port scan', checkPortScan],
    ['data folder', checkDataFolder],
    ['source discovery', checkSourceDiscovery],
  ];
  for (const [name, run] of checks) {
    console.log(`- ${name}`);
    try {
      await run(resolved);
    } catch (err) {
      console.error(`\n${err?.message ?? err}`);
      console.error(`\nPlatform smoke FAILED on ${process.platform}: ${name}`);
      process.exit(1);
    }
    console.log('');
  }
  console.log(`Platform smoke passed on ${process.platform}: ${passed.length} assertions.`);
}

// Only when run as a script: the test imports this module for its helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
