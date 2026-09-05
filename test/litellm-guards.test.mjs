// The four promises litellm/README.md makes about the Python spine (issue #188).
//
// Why node rather than a second CI job: the modules are Python, but the suite
// that gates every PR is `node --test`, and test/litellm-runtime.test.mjs
// already drives these same files by shelling out to python3. A parallel
// pytest job would mean a second runner, a second install step and a second
// place to look when something goes red, to pin four behaviours. So these
// shell out too, and ride the `check` job that already exists.
//
// python3 is not optional here: on a machine without it these would silently
// skip, and "the promise is guarded" would be a claim nothing checks. CI sets
// CHRONICLE_REQUIRE_PYTHON=1, which turns a missing interpreter into a failure
// instead of a skip. Locally, absence still skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LITELLM = path.join(REPO, 'litellm');

// Run a snippet with litellm/ importable. Never inherits the ambient
// LANE_C_SPEND_LOG: a shell that exported one would otherwise steer a guard at
// the operator's real log.
function py(code, env = {}) {
  return spawnSync('python3', ['-c', code], {
    cwd: LITELLM,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      LANE_C_SPEND_LOG: '',
      CHRONICLE_DATA_DIR: '',
      ...env,
    },
  });
}

// Returns the completed run, or skips (locally) / fails (in CI) with no python3.
function run(t, code, env) {
  const r = py(code, env);
  if (r.error) {
    if (process.env.CHRONICLE_REQUIRE_PYTHON) {
      assert.fail(`python3 is required here but did not run: ${r.error.message}`);
    }
    t.skip('no python3');
    return null;
  }
  assert.equal(r.status, 0, `python3 exited ${r.status}: ${r.stderr}`);
  return r;
}

const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// --- Promise 1: fail-soft ---------------------------------------------------
// "a logging error is swallowed and never breaks the request it was recording".
// The callback sits in LiteLLM's success path; anything it raises surfaces as a
// failed request the user already paid for.

test('a spend log that cannot be written never raises into the request path', (t) => {
  const dir = tmp(t, 'lanec-failsoft-');
  // A regular file where the parent DIRECTORY has to be: mkdir and open both
  // fail, which is the real shape of "the data dir got clobbered".
  const blocker = path.join(dir, 'blocked');
  fs.writeFileSync(blocker, 'not a directory\n');
  const unwritable = path.join(blocker, 'litellm', 'spend.jsonl');

  const r = run(t, `import json, sys
import lane_c_spend_logger as m

path = ${JSON.stringify(unwritable)}
ok = m.write_row({'model': 'm', 'total_tokens': 1}, path)

# And through the real callback entry points, which is how LiteLLM calls it.
log = m.LaneCSpendLogger(path)
payload = {'standard_logging_object': {
  'startTime': 1755000000.0, 'model': 'glm-5.2', 'response_cost': 0.01,
  'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2,
}}
log.log_success_event(payload, None, None, None)

import asyncio
asyncio.run(log.async_log_success_event(payload, None, None, None))

# A payload that is garbage in every direction must be inert too.
for junk in (None, {}, {'standard_logging_object': None},
             {'standard_logging_object': {'model': ''}},
             {'standard_logging_object': {'model': 'm', 'prompt_tokens': 'lots',
                                          'startTime': 'not-a-time'}}):
    log.log_success_event(junk, None, None, None)

print(json.dumps({'ok': ok}))`);
  if (!r) return;

  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.ok, false, 'write_row reported success on a path it cannot write');
  assert.equal(fs.existsSync(unwritable), false);
  // It said something on stderr: swallowed is not the same as silent.
  assert.match(r.stderr, /lane-c-spend/, 'a swallowed write failure left no trace at all');
});

// --- Promise 2: metrics only ------------------------------------------------
// "It NEVER carries message content, even though the success payload does."

test('no prompt or completion content can reach a spend row', (t) => {
  const dir = tmp(t, 'lanec-content-');
  const logPath = path.join(dir, 'spend.jsonl');
  // One sentinel per place a LiteLLM payload is known to carry text, plus the
  // places a future version might: if any of them is copied through, the row
  // or the file contains the marker.
  const S = 'CONTENT-SENTINEL-8f3a';

  const r = run(t, `import json
import lane_c_spend_logger as m

S = ${JSON.stringify(S)}
message = {'role': 'user', 'content': S}
slo = {
  'startTime': 1755000000.0, 'endTime': 1755000001.5, 'model': 'glm-5.2',
  'response_cost': 0.0125,
  'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120,
  'messages': [message],
  'input': [message],
  'output': [{'role': 'assistant', 'content': S}],
  'prompt': S,
  'completion': S,
  'metadata': {'user_api_key_alias': S},
  'response': {
    'provider': 'Fireworks',
    'choices': [{'message': {'role': 'assistant', 'content': S}}],
  },
  'hidden_params': {'upstream_provider': 'Fireworks', 'raw_request': S},
}
row = m.build_row(slo)
log = m.LaneCSpendLogger(${JSON.stringify(logPath)})
log.log_success_event({'standard_logging_object': slo}, None, None, None)
print(json.dumps(row))`);
  if (!r) return;

  const row = JSON.parse(r.stdout.trim());
  // A whitelist, not a blocklist: a new key has to be added here deliberately,
  // so a field that happens to carry text cannot arrive unnoticed.
  const ALLOWED = new Set([
    'startTime', 'model', 'prompt_tokens', 'completion_tokens', 'total_tokens',
    'spend', 'provider', 'latency_ms',
  ]);
  const extra = Object.keys(row).filter((k) => !ALLOWED.has(k));
  assert.deepEqual(extra, [], `the spend row grew unvetted keys: ${extra}`);

  assert.equal(JSON.stringify(row).includes(S), false, 'content reached the row');
  const raw = fs.readFileSync(logPath, 'utf8');
  assert.equal(raw.includes(S), false, 'content reached the JSONL on disk');

  // The metrics themselves did survive: this is not passing by writing nothing.
  assert.equal(row.model, 'glm-5.2');
  assert.equal(row.total_tokens, 120);
  assert.equal(row.provider, 'Fireworks');
  assert.equal(row.latency_ms, 1500);
});

// --- Promise 3: no guessed $0 -----------------------------------------------
// "a zero or absent cost yields a token-only row, never a guessed $0."
// A row with spend: 0 is indistinguishable from a genuinely free request, and
// the Spend tab would total it as truth instead of surfacing the gap.

test('a zero, absent or unusable cost yields a token-only row, never spend: 0', (t) => {
  const r = run(t, `import json
import lane_c_spend_logger as m

base = {'startTime': 1755000000.0, 'model': 'glm-5.2',
        'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}

cases = {
  'missing': {},
  'none': {'response_cost': None},
  'zero_float': {'response_cost': 0.0},
  'zero_int': {'response_cost': 0},
  'empty_string': {'response_cost': ''},
  'garbage': {'response_cost': 'free'},
  'negative': {'response_cost': -0.01},
  'positive': {'response_cost': 0.0125},
}
print(json.dumps({k: m.build_row({**base, **v}) for k, v in cases.items()}))`);
  if (!r) return;

  const rows = JSON.parse(r.stdout.trim());
  for (const name of ['missing', 'none', 'zero_float', 'zero_int', 'empty_string', 'garbage', 'negative']) {
    const row = rows[name];
    assert.ok(row, `${name}: the row was dropped entirely`);
    assert.equal('spend' in row, false, `${name}: a guessed spend key was emitted`);
    // The tokens are still there, so the request is still counted.
    assert.equal(row.total_tokens, 12, `${name}: the token-only row lost its tokens`);
  }
  assert.equal(rows.positive.spend, 0.0125, 'a real cost stopped being recorded');
});

// --- Promise 4: the roster refresher touches volatile columns only ----------
// "updates only the price and context columns ... never the judgment columns".
// The judgment columns are hand-curated; a refresher that rewrote them would
// quietly discard the curation on the next cron run.

test('refresh_roster rewrites price and context only, and adds or drops no row', (t) => {
  const dir = tmp(t, 'roster-guard-');
  const md = path.join(dir, 'model-routing.md');
  const before = [
    '# Routing',
    '',
    'Prose above the table stays put.',
    '',
    '| Model | Route | Tier | Trust | Task fit | Lane | Price in/out (auto) | Context (auto) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| glm | openrouter/z-ai/glm-5.2 | workhorse | no-train | code | C | $0.00 / $0.00 | 0 |',
    '| kimi | openrouter/moonshot/kimi-k3 | reach | unverified | long-ctx | C | $9.99 / $9.99 | 1 |',
    '| direct | anthropic/claude-opus-5 | flagship | first-party | judgment | A | $15.00 / $75.00 | 200000 |',
    '| absent | openrouter/vendor/not-in-catalog | scratch | unknown | none | - | $1.00 / $2.00 | 42 |',
    '',
    'Prose below the table stays put too.',
    '',
  ].join('\n');
  fs.writeFileSync(md, `${before}\n`);

  const r = run(t, `import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(LITELLM)})
import refresh_roster as rr

catalog = {
  'z-ai/glm-5.2': (0.5, 1.5, 131072),
  'moonshot/kimi-k3': (2.0, 8.0, 262144),
  # anthropic/claude-opus-5 is deliberately present, to prove the route prefix
  # rather than the model name is what decides a row is in scope.
  'anthropic/claude-opus-5': (99.0, 99.0, 1),
}
p = pathlib.Path(${JSON.stringify(md)})
new, changes = rr.update_roster_table(p.read_text(), catalog)
p.write_text(new)
print(json.dumps([c[0] for c in changes]))`);
  if (!r) return;

  const changed = JSON.parse(r.stdout.trim());
  assert.deepEqual(changed.sort(), ['openrouter/moonshot/kimi-k3', 'openrouter/z-ai/glm-5.2']);

  const after = fs.readFileSync(md, 'utf8');
  const rowsOf = (text) => text.split('\n').filter((l) => l.trimStart().startsWith('|'));
  const rowsBefore = rowsOf(before);
  const rowsAfter = rowsOf(after);
  assert.equal(rowsAfter.length, rowsBefore.length, 'the refresher added or dropped a row');

  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const headers = cells(rowsBefore[0]);
  const VOLATILE = new Set(['Price in/out (auto)', 'Context (auto)']);

  for (let i = 0; i < rowsBefore.length; i += 1) {
    const b = cells(rowsBefore[i]);
    const a = cells(rowsAfter[i]);
    assert.equal(a.length, b.length, `row ${i} changed its column count`);
    for (let c = 0; c < b.length; c += 1) {
      if (VOLATILE.has(headers[c])) continue;
      assert.equal(a[c], b[c], `a judgment column (${headers[c]}) was rewritten on row ${i}`);
    }
  }

  // The volatile columns did move, for the in-catalog openrouter rows only.
  assert.match(after, /\| \$0\.50 \/ \$1\.50 \| 131072 \|/);
  assert.match(after, /\| \$2\.00 \/ \$8\.00 \| 262144 \|/);
  // A non-openrouter route is out of scope even when the catalog knows it.
  assert.match(after, /anthropic\/claude-opus-5 .*\| \$15\.00 \/ \$75\.00 \| 200000 \|/);
  // A route the catalog does not carry keeps its stale numbers rather than
  // being blanked.
  assert.match(after, /not-in-catalog .*\| \$1\.00 \/ \$2\.00 \| 42 \|/);
  // And the prose around the table is untouched.
  assert.match(after, /^Prose above the table stays put\.$/m);
  assert.match(after, /^Prose below the table stays put too\.$/m);
});
