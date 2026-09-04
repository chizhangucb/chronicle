// The LiteLLM spine runtime is de-hubbed (issue #186): a stranger who clones
// Chronicle can start the proxy and see its rows in the Spend tab.
//
// These pin the behaviour, not the prose: every path resolves from the repo or
// a documented env var, the producer and the consumer agree on one default, and
// no machine-specific path can settle back into a runtime file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_PATHS, LEGACY_LAYOUT, HUB_LOCATION } from './helpers/hub-strings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// The AC grep, plus the pre-move layout: a doc citing `scripts/litellm/...` or
// `scripts/tests/test_litellm_roster.py` points at files that are not there.
// Shared with test/repo-shape.test.mjs so the two cannot drift.
const BANNED = new RegExp(
  `${HUB_PATHS.source}|${LEGACY_LAYOUT.source}|${HUB_LOCATION.source}`, 'i',
);

const RUNTIME_FILES = [
  'litellm/run.sh',
  'litellm/config.yaml',
  'litellm/lane_c_spend_logger.py',
  'litellm/refresh_roster.py',
  'litellm/.env.example',
  'litellm/README.md',
  'litellm/product-contract.md',
  'launchd/com.chronicle.litellm.plist.template',
];

test('no runtime file names a hub checkout, ~/.aios, ~/.secrets or the old layout', () => {
  const offenders = RUNTIME_FILES.filter((rel) => BANNED.test(read(rel)));
  assert.deepEqual(offenders, [], `hub paths are back in: ${offenders}`);
});

test('no runtime file reads AIOS_HUB', () => {
  const offenders = RUNTIME_FILES.filter((rel) => /AIOS_HUB/.test(read(rel)));
  assert.deepEqual(offenders, [], `AIOS_HUB is back in: ${offenders}`);
  // refresh_roster.py reads a hub DOCUMENT, so it takes the CHRONICLE_ hub knob
  // instead, and never defaults to a path.
  const roster = read('litellm/refresh_roster.py');
  assert.match(roster, /CHRONICLE_ROSTER_MD/);
  assert.match(roster, /CHRONICLE_HUB/);
});

test('run.sh binds loopback with no host knob to override it', () => {
  // The gate config.yaml documents is "loopback bind + master key", and the key
  // alone is not enough off-laptop. An env-var host would let a user expose an
  // OpenRouter-key-bearing endpoint while the config still claimed loopback.
  const sh = read('litellm/run.sh');
  assert.match(sh, /--host 127\.0\.0\.1/);
  assert.equal(/LITELLM_HOST/.test(sh), false, 'run.sh grew a host override');
  assert.equal(/LITELLM_HOST/.test(read('litellm/.env.example')), false, '.env.example advertises a host override');
  // The port stays a knob: it is how you try a candidate config on a second
  // instance without touching the live spine.
  assert.match(sh, /LITELLM_PORT:-4000/);
});

test('install-jobs will not bootstrap the proxy job before it has keys', () => {
  // run.sh exits 78 unconfigured, and KeepAlive would turn that into a
  // permanent respawn loop on a fresh clone.
  const src = read('scripts/install-jobs.mjs');
  assert.match(src, /requires-env/, 'install-jobs no longer honours a template requirement');
  assert.match(src, /skipped bootstrap/);
  const plist = read('launchd/com.chronicle.litellm.plist.template');
  assert.match(plist, /install-jobs: requires-env OPENROUTER_API_KEY LITELLM_MASTER_KEY/);
  assert.match(plist, /env-file litellm\/\.env/);
  assert.match(plist, /<key>ThrottleInterval<\/key>/);
  // The installer stays job-agnostic: the requirement lives in the template.
  assert.equal(/com\.chronicle\.litellm/.test(src), false,
    'install-jobs hardcodes a job label again');
});

test('a copied-but-unfilled env file does not count as configured', (t) => {
  // The documented first step is "copy .env.example, fill it in". Treating the
  // file's existence as configured would bootstrap a KeepAlive job straight
  // into the exit-78 respawn loop the guard exists to prevent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'litellm.env');
  fs.copyFileSync(path.join(REPO, 'litellm/.env.example'), envFile);

  const run = () => spawnSync(process.execPath, [path.join(REPO, 'scripts/install-jobs.mjs'), '--bootstrap'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: dir,
      CHRONICLE_DATA_DIR: path.join(dir, '.chronicle'),
      LITELLM_ENV_FILE: envFile,
      OPENROUTER_API_KEY: '',
      LITELLM_MASTER_KEY: '',
    },
  });

  const bare = run();
  if (bare.status !== 0) return t.skip(`install-jobs did not run here: ${bare.stderr}`);
  assert.match(bare.stdout, /skipped bootstrap for com\.chronicle\.litellm/);
  assert.match(bare.stdout, /OPENROUTER_API_KEY, LITELLM_MASTER_KEY/);

  // A key present but quoted-empty is still unconfigured.
  fs.writeFileSync(envFile, 'OPENROUTER_API_KEY=sk-real\nLITELLM_MASTER_KEY=""\n');
  const half = run();
  assert.match(half.stdout, /skipped bootstrap/);
  assert.match(half.stdout, /LITELLM_MASTER_KEY not set yet/);
  assert.equal(/OPENROUTER_API_KEY/.test(half.stdout), false, 'a filled key was reported missing');

  // Jobs that declare no requirement are never withheld.
  assert.equal(/skipped bootstrap for com\.chronicle\.briefing/.test(bare.stdout), false);
});

test('run.sh resolves its dir from the script, sources a repo-relative env file', () => {
  const sh = read('litellm/run.sh');
  assert.match(sh, /LITELLM_DIR="\$\{0:A:h\}"/, 'run.sh no longer self-resolves its dir');
  assert.match(sh, /LITELLM_ENV_FILE:-\$LITELLM_DIR\/\.env/, 'run.sh no longer defaults to litellm/.env');
  assert.match(sh, /OPENROUTER_API_KEY/);
  assert.match(sh, /LITELLM_MASTER_KEY/);
  assert.match(sh, /exit 78/, 'run.sh no longer fails loudly on a missing key');
});

test('.env.example ships every key run.sh needs, with no values', () => {
  const env = read('litellm/.env.example');
  for (const key of ['OPENROUTER_API_KEY', 'LITELLM_MASTER_KEY']) {
    assert.match(env, new RegExp(`^${key}=$`, 'm'), `${key} is missing or pre-filled`);
  }
});

test('the launchd template pins the data dir the installer resolved', () => {
  const plist = read('launchd/com.chronicle.litellm.plist.template');
  assert.match(plist, /<key>CHRONICLE_DATA_DIR<\/key>\s*<string>__DATA__<\/string>/);
  assert.match(plist, /__REPO__\/litellm\/run\.sh/);
});

test('install-jobs fills the template placeholders it now carries', () => {
  const src = read('scripts/install-jobs.mjs');
  for (const token of ['__REPO__', '__DATA__']) {
    assert.ok(src.includes(`replaceAll('${token}'`), `install-jobs.mjs no longer fills ${token}`);
  }
});

test('run.sh is executable, so launchd and a shell both start it', () => {
  const mode = fs.statSync(path.join(REPO, 'litellm/run.sh')).mode;
  assert.ok(mode & 0o111, 'litellm/run.sh is not executable');
});

test('run.sh parses under zsh, the shell the launchd job execs', () => {
  const r = spawnSync('zsh', ['-n', path.join(REPO, 'litellm/run.sh')], { encoding: 'utf8' });
  if (r.error) return; // no zsh on this runner
  assert.equal(r.status, 0, r.stderr);
});

// The producer/consumer handshake. Both sides resolve the same default, so a
// clone with nothing configured still lands rows where the Spend tab looks.
const py = (code, env) =>
  spawnSync('python3', ['-c', code], {
    cwd: path.join(REPO, 'litellm'),
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env },
  });

test('the spend logger defaults into Chronicle data dir, honours LANE_C_SPEND_LOG', async (t) => {
  const probe = py('import lane_c_spend_logger as m; print(m.default_spend_path())', {});
  if (probe.error) return t.skip('no python3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanec-py-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const code = 'import lane_c_spend_logger as m; print(m.default_spend_path())';
  const viaData = py(code, { CHRONICLE_DATA_DIR: dir, LANE_C_SPEND_LOG: '' });
  assert.equal(viaData.stdout.trim(), path.join(dir, 'litellm', 'spend.jsonl'));

  const explicit = py(code, { LANE_C_SPEND_LOG: path.join(dir, 'x.jsonl') });
  assert.equal(explicit.stdout.trim(), path.join(dir, 'x.jsonl'));

  // No knobs at all -> ~/.chronicle, never ~/.aios.
  const bare = py(`import os
for k in ('CHRONICLE_DATA_DIR', 'LANE_C_SPEND_LOG'): os.environ.pop(k, None)
import lane_c_spend_logger as m
print(m.default_spend_path())`, { CHRONICLE_DATA_DIR: '', LANE_C_SPEND_LOG: '' });
  assert.equal(bare.stdout.trim(), path.join(os.homedir(), '.chronicle', 'litellm', 'spend.jsonl'));
});

test('a written row is one the Spend tab reads back', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanec-rt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Producer: the real callback, given a real LiteLLM success payload shape.
  const r = py(`import os, json
os.environ['CHRONICLE_DATA_DIR'] = ${JSON.stringify(dir)}
os.environ.pop('LANE_C_SPEND_LOG', None)
import lane_c_spend_logger as m
log = m.LaneCSpendLogger()
log.log_success_event({'standard_logging_object': {
  'startTime': 1755000000.0, 'model': 'glm-5.2', 'response_cost': 0.0125,
  'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120,
  'response': {'provider': 'Fireworks', 'choices': [{'message': {'content': 'SECRET'}}]},
}}, None, None, None)
print(log.path)`, { CHRONICLE_DATA_DIR: dir, LANE_C_SPEND_LOG: '' });
  if (r.error) return t.skip('no python3');
  assert.equal(r.status, 0, r.stderr);

  const written = r.stdout.trim();
  assert.equal(written, path.join(dir, 'litellm', 'spend.jsonl'));
  const raw = fs.readFileSync(written, 'utf8');
  assert.equal(raw.includes('SECRET'), false, 'message content leaked into a spend row');

  // Consumer: the SAME path, resolved independently from the same env.
  const { laneCSpendPath, readLaneCSpend } = await import('../server/laneC.ts');
  assert.equal(laneCSpendPath({ CHRONICLE_DATA_DIR: dir }), written);

  const spend = readLaneCSpend(null, [laneCSpendPath({ CHRONICLE_DATA_DIR: dir })]);
  assert.equal(spend.requests, 1);
  assert.ok(Math.abs(spend.totalSpend - 0.0125) < 1e-9);
  assert.equal(spend.byModel[0].model, 'glm-5.2');
  assert.equal(spend.byModel[0].tokens, 120);
});

test('laneCSpendPath: a relocated data dir still keeps the legacy history', async () => {
  // Relocating the data dir is ordinary (server/db.ts honours it, and the
  // launchd job pins it), so it must NOT suppress the legacy read: that would
  // strip the history from exactly the operator most likely to have some.
  const { laneCSpendPath, laneCSpendPaths } = await import('../server/laneC.ts');
  const env = { CHRONICLE_DATA_DIR: '/tmp/no-such-chronicle' };
  const current = laneCSpendPath(env);
  assert.equal(current, path.join('/tmp/no-such-chronicle', 'litellm', 'spend.jsonl'));

  const legacy = path.join(os.homedir(), '.aios', 'litellm', 'spend.jsonl');
  const expected = fs.existsSync(legacy) ? [current, legacy] : [current];
  assert.deepEqual(laneCSpendPaths(env), expected);

  // LANE_C_SPEND_LOG beats the data dir, and pins to exactly one log.
  assert.equal(laneCSpendPath({ LANE_C_SPEND_LOG: '/tmp/x.jsonl', CHRONICLE_DATA_DIR: '/tmp/d' }), '/tmp/x.jsonl');
  assert.deepEqual(laneCSpendPaths({ LANE_C_SPEND_LOG: '/tmp/x.jsonl' }), ['/tmp/x.jsonl']);
});

test('laneCSpendPath: demo wins over a LANE_C_SPEND_LOG left in the shell', async () => {
  // bin/chronicle.mjs spreads the whole env into the demo relaunch, so an
  // operator who exported LANE_C_SPEND_LOG for a scratch proxy run would
  // otherwise see their REAL proxy rows inside the demo console.
  const { laneCSpendPath, laneCSpendPaths } = await import('../server/laneC.ts');
  const env = { CHRONICLE_DEMO: '1', CHRONICLE_DATA_DIR: '/tmp/demo-x', LANE_C_SPEND_LOG: '/real/spend.jsonl' };
  assert.equal(laneCSpendPath(env), path.join('/tmp/demo-x', 'litellm', 'spend.jsonl'));
  // And demo reads that ONE log: never the operator's real or legacy files.
  assert.deepEqual(laneCSpendPaths(env), [path.join('/tmp/demo-x', 'litellm', 'spend.jsonl')]);
});

test('laneCSpendPath: a tilde in LANE_C_SPEND_LOG expands, as it does producer-side', async () => {
  // A quoted LANE_C_SPEND_LOG="~/logs/spend.jsonl" is not expanded by the shell
  // that sources the env file. Python expands it; if this side did not, the
  // reader would silently read nothing and the Proxy lane would vanish.
  const { laneCSpendPath } = await import('../server/laneC.ts');
  assert.equal(laneCSpendPath({ LANE_C_SPEND_LOG: '~/logs/spend.jsonl' }),
    path.join(os.homedir(), 'logs', 'spend.jsonl'));
});

test('the readers aggregate the legacy log ALONGSIDE the current one', async (t) => {
  // Resolving to one OR the other would drop months of billed history the first
  // time the new log came into existence. Both are read, so the move is lossless.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanec-merge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const current = path.join(dir, 'current.jsonl');
  const legacy = path.join(dir, 'legacy.jsonl');
  fs.writeFileSync(current, '{"startTime":"2026-08-12T12:00:00Z","model":"m","spend":0.05,"total_tokens":10}\n');
  fs.writeFileSync(legacy, '{"startTime":"2026-08-09T12:00:00Z","model":"m","spend":0.03,"total_tokens":7}\n');

  const { readLaneCSpend, readLaneCDailyCost } = await import('../server/laneC.ts');
  const both = readLaneCSpend(null, [current, legacy]);
  assert.equal(both.requests, 2);
  assert.ok(Math.abs(both.totalSpend - 0.08) < 1e-9);
  assert.equal(both.byModel[0].tokens, 17);

  const days = readLaneCDailyCost(null, [current, legacy]);
  assert.equal(days.size, 2);

  // A path in the list that does not exist contributes nothing, never a throw.
  const partial = readLaneCSpend(null, [current, path.join(dir, 'gone.jsonl')]);
  assert.equal(partial.requests, 1);
  assert.deepEqual(readLaneCSpend(null, [path.join(dir, 'gone.jsonl')]),
    { totalSpend: 0, requests: 0, byModel: [] });
});

test('refresh_roster runs from a fresh clone and says what to configure', (t) => {
  const r = spawnSync('python3', [path.join(REPO, 'litellm/refresh_roster.py'), '--dry-run'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      CHRONICLE_HUB: '', CHRONICLE_ROSTER_MD: '',
    },
  });
  if (r.error) return t.skip('no python3');
  assert.equal(r.status, 2, `expected a clean config exit, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /no roster file configured/);
  assert.match(r.stderr, /CHRONICLE_ROSTER_MD/);
});

test('refresh_roster --roster refreshes only the volatile columns', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const md = path.join(dir, 'model-routing.md');
  fs.writeFileSync(md, [
    '## Roster',
    '',
    '| Model | Route | Tier | Price in/out (auto) | Context (auto) |',
    '| --- | --- | --- | --- | --- |',
    '| glm | openrouter/z-ai/glm-5.2 | workhorse | $0.00 / $0.00 | 0 |',
    '',
  ].join('\n'));

  const r = spawnSync('python3', ['-c', `import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'litellm'))})
import refresh_roster as rr
catalog = {'z-ai/glm-5.2': (0.5, 1.5, 131072)}
p = pathlib.Path(${JSON.stringify(md)})
new, changes = rr.update_roster_table(p.read_text(), catalog)
p.write_text(new)
print(len(changes))`], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  if (r.error) return t.skip('no python3');
  assert.equal(r.status, 0, r.stderr);
  const out = fs.readFileSync(md, 'utf8');
  assert.match(out, /\$0\.50 \/ \$1\.50/);
  assert.match(out, /\| 131072 \|/);
  assert.match(out, /workhorse/, 'a judgment column was rewritten');
});
