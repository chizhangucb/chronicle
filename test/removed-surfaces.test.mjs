// The one removal pin: every surface Chronicle retired stays retired.
//
// Folded from three overlapping files (audit F20): the route pin, the
// after-the-views pin and the CLI pin all asked the same question of three
// different seams, so they read as three suites here rather than three files.
// The retired-word sweep stays in test/repo-shape.test.mjs: it guards the
// glossary, not the surfaces.
//
// Three seams, one per suite:
//   1. HTTP  - a retired route answers 404, its surviving neighbours do not.
//   2. HTTP  - the routes that outlived the contract_* views still answer.
//   3. CLI   - the launcher's exit code and stderr, plus the source text that
//              could re-introduce a retired env knob or config key.
//
// Everything server-side is imported DYNAMICALLY, after DATA_DIR is set below:
// server/db.ts opens <dir>/chronicle.db and server/config.ts freezes its data
// folder AT IMPORT TIME, and a static import would run before this file gets to
// point them at a temp dir. One dir, one database, one config module for the
// whole file, so the suites below share state on purpose rather than by
// accident: each seeds under its own ids and reads only what it seeded.
//
// The routers are mounted directly rather than importing server/api.ts, which
// starts auto-sync watchers and would never let the test process exit.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-removed-'));
process.env.CHRONICLE_DATA_DIR = DATA_DIR;

/** Mounts the named routers on a fresh app and listens on an ephemeral port.
 *  Returns the base URL and a close function for the suite's `after`. */
async function serve(mounts) {
  const app = express();
  app.use(express.json());
  for (const [mod, fn] of mounts) {
    (await import(`../server/routes/${mod}.ts`))[fn](app);
  }
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// --- 1. Removed routes ------------------------------------------------------
//
// Removal pin for the shrink (#220, #221, #222) and for context causality
// (#298): the briefing, the launcher, the memory scope-suggest runner, every
// route under the hub prefix, the routing roster, the whole write gate and the
// per-session causality read are gone, so their routes must be UNMOUNTED, not
// stubbed. A 404 here is the observable an API client sees; asserting module
// shape would pin the implementation instead of the product.
//
// The surviving neighbours are asserted in the same run so a wholesale
// mis-mount (an app that answers 404 for everything) cannot pass this suite.
describe('the routes a removal unmounted', () => {
  // A session that really exists in the temp database. The causality pin below
  // asks for it BY THIS ID so the 404 can only mean "route unmounted": a
  // stubbed or re-added route that 404s unknown sessions (the shape every other
  // `/sessions/:id/...` route uses) would still answer for a seeded one.
  const SEEDED_SESSION = 'removed-surfaces-session-1';

  let baseUrl, close;

  before(async () => {
    const { db, upsertProject } = await import('../server/db.ts');
    const project = upsertProject('/proj');
    db.prepare(
      `INSERT INTO sessions (id, project_id, source, file_path, message_count)
       VALUES (?, ?, 'claude-code', '/proj/session.jsonl', 0)`,
    ).run(SEEDED_SESSION, project.id);
    ({ baseUrl, close } = await serve([
      ['settings', 'mountSettings'],
      ['sessions', 'mountSessions'],
    ]));
  });
  after(async () => { await close?.(); });

  // The briefing and hub routers are deleted outright, so there is nothing left
  // to mount: these paths can only 404. Every route the hub router used to
  // serve is listed, so re-mounting any one of them fails here.
  const GONE = [
    ['GET', '/briefing'],
    ['GET', '/briefing/run-status'],
    ['POST', '/briefing/action'],
    ['POST', '/briefing/run'],
    ['POST', '/launch/gap'],
    ['POST', '/memory/scope-suggest'],
    ['GET', '/memory/scope-suggest/status'],
    ['GET', '/hub/memory/summary'],
    ['GET', '/hub/status'],
    ['GET', '/hub/safety'],
    ['GET', '/hub/safety/confidential'],
    ['GET', '/hub/codegraphs'],
    ['POST', '/hub/config'],
    ['GET', '/routing'],
    // The write gate (#222). Its surviving remnant is the renamed per-boot
    // token guard, pinned in test/write-token.test.mjs.
    ['GET', '/gate/token'],
    ['GET', '/gate/surfaces'],
    ['GET', '/gate/surface'],
    ['GET', '/gate/jobs'],
    ['GET', '/gate/audit'],
    ['POST', '/gate/propose'],
    ['POST', '/gate/apply'],
    ['POST', '/gate/confirm'],
    ['POST', '/gate/undo'],
    // The local view log. Its module went with the route, so there is no
    // recorder left to mount even if a caller kept the URL.
    ['POST', '/view-log'],
    ['GET', '/view-log/summary'],
    ['DELETE', '/view-log'],
    ['PATCH', '/view-log/settings'],
    // Context causality (#298): the heuristic read-to-change read is gone, so
    // the sessions router must not answer for it. Its neighbours on the same
    // router are asserted below, so an unmounted sessions router cannot pass.
    ['GET', `/sessions/${SEEDED_SESSION}/causality`],
  ];

  test('every removed route is unmounted (404)', async () => {
    for (const [method, route] of GONE) {
      const res = await fetch(`${baseUrl}${route}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      assert.equal(res.status, 404, `${method} ${route} answered ${res.status}, not 404`);
    }
  });

  test('the surviving neighbours on the same routers still answer', async () => {
    for (const route of ['/settings', '/sessions/minor']) {
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.ok, true, `${route} answered ${res.status}`);
    }
  });

  test('/settings no longer carries the homeBands toggle', async () => {
    const cfg = await (await fetch(`${baseUrl}/settings`)).json();
    assert.equal('homeBands' in cfg, false);
  });

  test('no briefing or briefing-state file is written under the data dir', async () => {
    await fetch(`${baseUrl}/settings`);
    const files = fs.readdirSync(DATA_DIR);
    assert.equal(files.some((f) => f.startsWith('briefing')), false, `data dir holds ${files.join(', ')}`);
  });
});

// --- 2. The routes that outlived the contract views -------------------------
//
// With the contract_* views removed, every read route that used to sit
// alongside them still answers from the base tables.
//
// The views were never in a route's query path, so this is a pin rather than a
// discovery: it fails loudly if a later removal pass takes a base column or a
// join the engines actually read. One seeded session with real token cells is
// enough -- each route is asserted on its shape and on the session being
// visible, not on a magic number.
describe('the routes that outlived the contract views', () => {
  const HOUR = 3600000;
  const iso = (ms) => new Date(ms).toISOString();
  const now = Date.now();
  const MODEL = 'claude-sonnet-5';

  let dbModule, baseUrl, close, projectId;

  const get = async (p) => {
    const res = await fetch(`${baseUrl}${p}`);
    assert.equal(res.status, 200, `${p} answered ${res.status}`);
    return res.json();
  };

  before(async () => {
    dbModule = await import('../server/db.ts');

    const p = dbModule.upsertProject('/tmp/views-proj');
    projectId = p.id;

    // Twelve assistant messages spread over three hours: past the noise gate on
    // both axes, so the session shows up on the windowed surfaces too.
    const events = Array.from({ length: 12 }, (_, i) => ({
      kind: 'assistant',
      model: MODEL,
      ts: iso(now - (3 * HOUR) + i * 12 * 60000),
      input_tokens: 10,
      output_tokens: 5,
      text: `assistant reply ${i} with enough text to carry a character share`,
    }));
    dbModule.replaceSession(
      {
        id: 'views', project_id: projectId, source: 'claude-code', file_path: '/tmp/views.jsonl',
        started_at: iso(now - 3 * HOUR), ended_at: iso(now - 60000),
        usage: JSON.stringify({ [MODEL]: { input: 120, output: 60, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }),
      },
      events,
    );

    ({ baseUrl, close } = await serve([
      ['insights', 'mountInsights'], ['explore', 'mountExplore'], ['content', 'mountContent'],
      ['sessions', 'mountSessions'], ['projects', 'mountProjects'], ['search', 'mountSearch'],
      ['security', 'mountSecurity'],
    ]));
  });
  after(async () => { await close?.(); });

  test('the database carries no contract_* view', () => {
    const views = dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all();
    assert.deepEqual(views.map((v) => v.name).filter((n) => n.startsWith('contract_')), []);
  });

  test('analytics routes answer from the base tables', async () => {
    const insights = await get('/insights');
    assert.ok(insights && typeof insights === 'object', '/insights returns an object');

    const explore = await get('/explore?group=model');
    const rows = explore.rows ?? explore.groups ?? [];
    assert.ok(rows.length > 0, '/explore groups the seeded session by model');

    const content = await get('/content');
    assert.ok(content && typeof content === 'object', '/content returns an object');
  });

  test('session, project, search and security routes answer', async () => {
    const projects = await get('/projects');
    const list = Array.isArray(projects) ? projects : projects.projects;
    assert.ok(list.some((p) => p.id === projectId), 'seeded project is listed');

    const project = await get(`/projects/${projectId}`);
    assert.ok(project && typeof project === 'object', '/projects/:id returns an object');

    const messages = await get('/sessions/views/messages');
    const rows = Array.isArray(messages) ? messages : messages.messages;
    assert.equal(rows.length, 12, 'every seeded message comes back');

    const search = await get('/search?q=assistant');
    assert.ok(search && typeof search === 'object', '/search returns an object');

    const rules = await get('/security/rules');
    assert.ok(Array.isArray(rules) || typeof rules === 'object', '/security/rules answers');
  });
});

// --- 3. The CLI inputs a removal took away ----------------------------------
//
// Removal pin for the shrink (#224): the `chronicle hub set|status|clear`
// subcommand, its entrypoint validation, the hub env vars and the config key
// are gone. The launcher takes flags only.
//
// The launcher is exercised as a real child process rather than imported: it
// starts a server on import, and the exit code + stderr are what a user
// actually sees.
describe('the CLI inputs a removal took away', () => {
  const BIN = path.join(REPO, 'bin', 'chronicle.mjs');

  function run(args, env = {}) {
    try {
      const stdout = execFileSync(process.execPath, [BIN, ...args], {
        encoding: 'utf8', env: { ...process.env, ...env },
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  test('--help lists the live flags and no hub anything', () => {
    const { code, stdout } = run(['--help']);
    assert.equal(code, 0);
    for (const flag of ['--port', '--no-open', '--demo', '--app', '--help']) {
      assert.match(stdout, new RegExp(flag.replace(/-/g, '\\-')));
    }
    assert.doesNotMatch(stdout, /hub/i);
  });

  test('a hub subcommand is rejected as an unknown command', () => {
    for (const args of [['hub'], ['hub', 'status'], ['hub', 'set', '/tmp/x'], ['hub', 'clear']]) {
      const { code, stderr } = run(args);
      assert.equal(code, 1, `expected rejection for: ${args.join(' ')}`);
      assert.match(stderr, /Unknown command "hub"/);
    }
  });

  test('--port keeps taking its value; a stray word still fails', () => {
    // The port value is a bare word too, so the unknown-command scan must skip it.
    assert.equal(run(['--port', 'nope']).code, 1); // invalid port, not "unknown command"
    assert.match(run(['--port', 'nope']).stderr, /Invalid --port/);
    assert.match(run(['sync']).stderr, /Unknown command "sync"/);
  });

  test('no entrypoint or server file reads a hub env var', () => {
    // server/gate/core.ts still carries an injected `hubRoot` option for the
    // hub-writing gate surfaces; nothing feeds it, and those rows are retired by
    // their own ticket. What must never come back here is a hub knob READ from
    // the environment.
    const files = [
      'bin/chronicle.mjs',
      ...fs.readdirSync(path.join(REPO, 'server'), { recursive: true })
        .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
        .map((f) => path.join('server', f)),
    ];
    const offenders = files.filter((rel) => {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      return /CHRONICLE_HUB|process\.env\.AIOS_HUB/.test(src);
    });
    assert.deepEqual([...new Set(offenders)], [], `hub env knobs are back in: ${offenders}`);
  });

  test('ChronicleConfig no longer declares the hub config key', () => {
    // ChronicleConfig lives in server/config.ts since #303; reading autosync.ts
    // here would grep a file that declares no config key at all and pass whatever
    // the type says.
    const src = fs.readFileSync(path.join(REPO, 'server', 'config.ts'), 'utf8');
    assert.match(src, /interface ChronicleConfig/, 'ChronicleConfig moved again');
    assert.doesNotMatch(src, /hubRoot/);
  });

  test('a config file that still holds the legacy hubRoot key loads and round-trips', async () => {
    // The shared data folder, not a fresh one: server/config.ts freezes its
    // folder at import and db.ts already imported it above, so a second temp
    // dir would only be read by a second module instance. Writing the legacy
    // file into the folder this process is actually bound to is what makes the
    // read and the write below go through the SAME reader the product uses.
    // This suite runs last, so nothing else reads the file after it changes.
    const { readConfig, writeConfig } = await import('../server/config.ts');
    const configPath = path.join(DATA_DIR, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ hubRoot: '/some/old/hub', autoSync: false }, null, 2),
    );
    assert.equal(readConfig().autoSync, false);
    writeConfig({ autoSync: true });
    const after = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(after.autoSync, true);
    assert.equal(after.hubRoot, '/some/old/hub', 'legacy key must survive a write');
  });
});
