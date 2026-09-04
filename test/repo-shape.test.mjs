// Repo-shape pins for the standalone restructure (issue #176, part of #173).
//
// Asserts the negatives the restructure introduced, so a retired folder, a
// rewired hook, a drifted instructions pointer, or a hub string in a doc trips
// CI instead of quietly settling back in.
//
// Reads git-tracked paths only (`git ls-files`), so gitignored artifacts
// (dist/, node_modules/, .DS_Store) can never make this flaky.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

const tracked = git('ls-files').split('\n').filter(Boolean);
const topLevel = new Set(tracked.map((p) => p.split('/')[0]));

// Folders the restructure retired. The hub seams (records/, plans/) and the
// repo-managed harness hooks are gone; none may be tracked again.
const RETIRED_ROOT = ['records', 'plans', 'governance', 'hooks'];

// The doc surfaces the restructure owns. litellm/README.md is deliberately out:
// it is an operational runbook for a spine that genuinely reaches the hub
// scripts dir, and the runtime AIOS_HUB knob is a product feature #173 leaves
// untouched. CHANGELOG.md is out because history is allowed to name what was.
const DOC_GLOBS = ['AGENTS.md', 'README.md', 'docs/**/*.md', 'spec/**/*.md'];
const HUB_STRINGS = /chizhang-2|governance\//i;

test('no retired folder is tracked at the repo root', () => {
  const back = RETIRED_ROOT.filter((name) => topLevel.has(name));
  assert.deepEqual(back, [], `retired root folders are tracked again: ${back}`);
});

test('no harness hooks directory is tracked anywhere', () => {
  const offenders = tracked.filter(
    (p) => p.startsWith('hooks/') || p.includes('/hooks/'),
  );
  assert.deepEqual(offenders, [], `a hooks directory is tracked again: ${offenders}`);
});

test('.claude/settings.json wires no hooks and names no hub', () => {
  const raw = fs.readFileSync(path.join(REPO, '.claude/settings.json'), 'utf8');
  assert.equal(HUB_STRINGS.test(raw), false, 'settings.json names the hub');
  const settings = JSON.parse(raw);
  assert.equal('hooks' in settings, false, 'settings.json wires hooks again');
});

test('AGENTS.md is the canonical floor and CLAUDE.md is a symlink to it', () => {
  assert.ok(tracked.includes('AGENTS.md'), 'AGENTS.md is not tracked');
  assert.ok(tracked.includes('CLAUDE.md'), 'CLAUDE.md is not tracked');
  const claude = path.join(REPO, 'CLAUDE.md');
  assert.ok(fs.lstatSync(claude).isSymbolicLink(), 'CLAUDE.md is not a symlink');
  assert.equal(fs.readlinkSync(claude), 'AGENTS.md');
  assert.ok(fs.statSync(claude).isFile(), 'CLAUDE.md does not resolve to a file');
});

test('the owned docs name no hub path', () => {
  const docs = git('ls-files', '--', ...DOC_GLOBS).split('\n').filter(Boolean);
  assert.ok(docs.length > 5, `expected the doc set to be populated, got ${docs.length}`);
  const offenders = docs.filter((rel) =>
    HUB_STRINGS.test(fs.readFileSync(path.join(REPO, rel), 'utf8')),
  );
  assert.deepEqual(offenders, [], `docs still name the hub: ${offenders}`);
});

test('the website build excludes docs/agents and docs/adr from the public site', () => {
  const src = fs.readFileSync(
    path.join(REPO, 'website/scripts/build-content.mjs'),
    'utf8',
  );
  const line = src.match(/const EXCLUDE = new Set\(\[([^\]]*)\]\)/);
  assert.ok(line, 'build-content.mjs no longer declares an EXCLUDE set');
  const excluded = [...line[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const name of ['agents', 'adr']) {
    assert.ok(excluded.includes(name), `docs/${name} is no longer excluded from the site`);
  }
});
