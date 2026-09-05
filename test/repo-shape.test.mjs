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
import { HUB_PATHS, HUB_FOLDERS } from './helpers/hub-strings.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

const tracked = git('ls-files').split('\n').filter(Boolean);
const topLevel = new Set(tracked.map((p) => p.split('/')[0]));

// Folders the restructure retired. The hub seams (records/, plans/) and the
// repo-managed harness hooks are gone; none may be tracked again.
const RETIRED_ROOT = ['records', 'plans', 'governance', 'hooks'];

// The doc surfaces the restructure owns. litellm/README.md is out of this set
// because test/litellm-runtime.test.mjs guards it instead, alongside the runtime
// it documents (issue #186 de-hubbed both). CHANGELOG.md is out because history
// is allowed to name what was.
const DOC_GLOBS = ['AGENTS.md', 'README.md', 'docs/**/*.md', 'spec/**/*.md'];
const HUB_STRINGS = new RegExp(`${HUB_PATHS.source}|${HUB_FOLDERS.source}`, 'i');

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

// --- Guard replacement (issue #175, part of #173) -------------------------
//
// The custom confidentiality and staleness guards are gone, replaced by
// gitleaks in CI plus GitHub's own settings (secret scanning push protection,
// require-branches-up-to-date on main). These pins stop a hand-rolled guard
// growing back and stop the gitleaks job losing its version pin.

// Scripts #175 retired. Their CI jobs went with them; the scan they stood in
// for is gitleaks', and the staleness check is branch protection's `strict`.
const RETIRED_GUARDS = [
  'scripts/confidentiality_guard.py',
  'scripts/tests/test_confidentiality_guard.py',
  'scripts/landing_preflight.mjs',
  'test/landing-preflight.test.mjs',
];

const ci = () => fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');
const ciJobIds = () => [...ci().matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]);

test('no retired guard script is tracked', () => {
  const back = RETIRED_GUARDS.filter((rel) => tracked.includes(rel));
  assert.deepEqual(back, [], `a retired guard script is tracked again: ${back}`);
});

test('CI declares no hand-rolled confidentiality or staleness job', () => {
  const back = ciJobIds().filter((id) => id === 'confidentiality' || id === 'staleness');
  assert.deepEqual(back, [], `a retired CI job is declared again: ${back}`);
});

// The shrink (spec #215) left `scripts/` holding only Chronicle's own tooling, and
// took every dormant job template out of the published tarball. `install-jobs.mjs`
// and the LiteLLM plist stay TRACKED for the optional local proxy spine, but a user
// who runs `npx chronicle-cli` must never receive a scheduled-job template they did
// not ask for -- so the npm `files` list ships neither.
const HUB_ONLY_SCRIPTS = [
  'scripts/emit-daily-digest.ts',
  'launchd/com.chronicle.daily-digest.plist.template',
];

test('no hub-only script or job template is tracked', () => {
  const back = HUB_ONLY_SCRIPTS.filter((rel) => tracked.includes(rel));
  assert.deepEqual(back, [], `a hub-only script is tracked again: ${back}`);
});

test('the published package ships no job template', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const files = pkg.files ?? [];
  assert.ok(!files.includes('launchd'), '`launchd` is back in the published files list');
  assert.ok(
    files.includes('!scripts/install-jobs.mjs'),
    'the job installer is no longer excluded from the published files list',
  );
  // Every tracked job template lives under launchd/, which is not published; a
  // template anywhere else would slip past that exclusion.
  const strays = tracked.filter(
    (rel) => /\.(plist|plist\.template)$|crontab/.test(rel) && !rel.startsWith('launchd/'),
  );
  assert.deepEqual(strays, [], `a job template is tracked outside launchd/: ${strays}`);
});

test('CI declares a gitleaks job, pinned by version and checksum', () => {
  assert.ok(ciJobIds().includes('gitleaks'), 'ci.yml declares no `gitleaks` job');
  const src = ci();
  assert.match(src, /GITLEAKS_VERSION: '\d+\.\d+\.\d+'/, 'the gitleaks version is not pinned');
  assert.match(src, /GITLEAKS_SHA256: '[0-9a-f]{64}'/, 'the gitleaks download is not checksum-pinned');
  assert.match(src, /sha256sum -c/, 'the gitleaks download is never checksum-verified');
});
