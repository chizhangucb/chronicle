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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// The AC grep: hub checkout paths, the hub env var, and the two machine-only
// directories the runtime used to reach into.
const HUB_STRINGS = /chizhang-2|\.aios\/|\.secrets\//;

const RUNTIME_FILES = [
  'litellm/run.sh',
  'litellm/config.yaml',
  'litellm/lane_c_spend_logger.py',
  'litellm/refresh_roster.py',
  'litellm/.env.example',
  'launchd/com.chronicle.litellm.plist.template',
];

test('no runtime file names a hub checkout, ~/.aios or ~/.secrets', () => {
  const offenders = RUNTIME_FILES.filter((rel) => HUB_STRINGS.test(read(rel)));
  assert.deepEqual(offenders, [], `hub paths are back in: ${offenders}`);
});

test('no runtime file reads AIOS_HUB', () => {
  const offenders = RUNTIME_FILES.filter((rel) => /AIOS_HUB/.test(read(rel)));
  assert.deepEqual(offenders, [], `AIOS_HUB is back in: ${offenders}`);
  // refresh_roster.py reads a hub DOCUMENT, so it takes the CHRONICLE_ hub knob
  // instead — and never defaults to a path.
  const roster = read('litellm/refresh_roster.py');
  assert.match(roster, /CHRONICLE_ROSTER_MD/);
  assert.match(roster, /CHRONICLE_HUB/);
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

  const spend = readLaneCSpend(null, laneCSpendPath({ CHRONICLE_DATA_DIR: dir }));
  assert.equal(spend.requests, 1);
  assert.ok(Math.abs(spend.totalSpend - 0.0125) < 1e-9);
  assert.equal(spend.byModel[0].model, 'glm-5.2');
  assert.equal(spend.byModel[0].tokens, 120);
});

test('laneCSpendPath: an explicit data dir never falls back to the legacy log', async () => {
  const { laneCSpendPath } = await import('../server/laneC.ts');
  const pinned = laneCSpendPath({ CHRONICLE_DATA_DIR: '/tmp/no-such-chronicle' });
  assert.equal(pinned, path.join('/tmp/no-such-chronicle', 'litellm', 'spend.jsonl'));
  assert.equal(pinned.includes('.aios'), false);
  // A demo run pins CHRONICLE_DATA_DIR, so demo can never read the real log.
  const demo = laneCSpendPath({ CHRONICLE_DEMO: '1', CHRONICLE_DATA_DIR: '/tmp/demo-x' });
  assert.equal(demo, path.join('/tmp/demo-x', 'litellm', 'spend.jsonl'));
  // LANE_C_SPEND_LOG wins over everything.
  assert.equal(laneCSpendPath({ LANE_C_SPEND_LOG: '/tmp/x.jsonl', CHRONICLE_DATA_DIR: '/tmp/d' }), '/tmp/x.jsonl');
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
