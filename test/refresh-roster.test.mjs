// The roster refresher's own suite (issue #192).
//
// The script maintains the volatile columns of the routing roster that
// server/routing.ts reads and the Spend tab's ROUTING COMPLIANCE section
// renders. It lived in litellm/ only because it was adjacent there in an older
// layout: the proxy never reads the roster and the roster never configures the
// proxy, so #192 moved it to scripts/ and its guards moved here with it, out of
// the two LiteLLM suites.
//
// The filename stays snake_case against the repo's kebab-case script
// convention because it is an importable Python module, and `import
// refresh-roster` is not a thing. The offline rewriting functions are tested by
// importing them; a dash would force every caller through importlib to buy
// nothing.
//
// python3 is not optional in CI: test/helpers/python.mjs holds the one
// skip-or-fail rule this suite shares with the LiteLLM ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skipWithoutPython } from './helpers/python.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'scripts/refresh_roster.py');
const SCRIPTS_DIR = path.join(REPO, 'scripts');

const tmp = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Never inherits an ambient CHRONICLE_ROSTER_MD: a shell that exported one
// would otherwise steer a guard at the operator's real roster.
const py = (args, env = {}) => spawnSync('python3', args, {
  encoding: 'utf8',
  env: {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    CHRONICLE_ROSTER_MD: '',
    ...env,
  },
});

test('the refresher runs from a fresh clone and says what to configure', (t) => {
  const r = py([SCRIPT, '--dry-run']);
  if (skipWithoutPython(t, r)) return;
  assert.equal(r.status, 2, `expected a clean config exit, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /no roster file configured/);
  assert.match(r.stderr, /CHRONICLE_ROSTER_MD/);
});

test('--roster refreshes only the volatile columns', (t) => {
  const dir = tmp(t, 'roster-');
  const md = path.join(dir, 'model-routing.md');
  fs.writeFileSync(md, [
    '## Roster',
    '',
    '| Model | Route | Tier | Price in/out (auto) | Context (auto) |',
    '| --- | --- | --- | --- | --- |',
    '| glm | openrouter/z-ai/glm-5.2 | workhorse | $0.00 / $0.00 | 0 |',
    '',
  ].join('\n'));

  const r = py(['-c', `import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})
import refresh_roster as rr
catalog = {'z-ai/glm-5.2': (0.5, 1.5, 131072)}
p = pathlib.Path(${JSON.stringify(md)})
new, changes = rr.update_roster_table(p.read_text(), catalog)
p.write_text(new)
print(len(changes))`]);
  if (skipWithoutPython(t, r)) return;
  assert.equal(r.status, 0, r.stderr);
  const out = fs.readFileSync(md, 'utf8');
  assert.match(out, /\$0\.50 \/ \$1\.50/);
  assert.match(out, /\| 131072 \|/);
  assert.match(out, /workhorse/, 'a judgment column was rewritten');
});

// The judgment columns are hand-curated; a refresher that rewrote them would
// quietly discard the curation on the next run. This was Promise 4 of
// litellm/README.md before the move (issue #188).
test('the refresher rewrites price and context only, and adds or drops no row', (t) => {
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

  const r = py(['-c', `import json, pathlib, sys
sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})
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
print(json.dumps([c[0] for c in changes]))`]);
  if (skipWithoutPython(t, r)) return;
  assert.equal(r.status, 0, `python3 exited ${r.status}: ${r.stderr}`);

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

test('npm run refresh-roster reaches the script from its new home', () => {
  // It had no npm script before the move, which is part of why it drifted out
  // of sight in litellm/. The pin is that the wiring names a file that exists.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const cmd = pkg.scripts?.['refresh-roster'];
  assert.ok(cmd, 'package.json declares no `refresh-roster` script');
  const cited = cmd.match(/\S+\.py/)?.[0];
  assert.ok(cited, `the refresh-roster script names no .py file: ${cmd}`);
  assert.ok(fs.existsSync(path.join(REPO, cited)), `refresh-roster points at a missing file: ${cited}`);
  // It maintains the operator's own document. `scripts` is in the published
  // files list, so without an exclusion the move would start shipping this to
  // everyone who runs `npx chronicle-cli`, the way the shrink stopped shipping
  // job templates.
  assert.ok(
    (pkg.files ?? []).includes(`!${cited}`),
    `the refresher is published in the tarball: add "!${cited}" to files`,
  );
});
