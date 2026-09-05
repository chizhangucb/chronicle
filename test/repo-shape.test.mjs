// Repo-shape pins for the standalone restructure (issue #176, part of #173).
//
// Asserts the negatives the restructure introduced, so a retired folder, a
// rewired hook, a drifted instructions pointer, or a retired word in a doc trips
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
import {
  PRIVATE_PATHS,
  PRIVATE_FOLDERS,
  RETIRED_WORDS,
  RETIRED_ROUTE_PREFIXES,
  RETIRED_MODULE_PATHS,
} from './helpers/retired-vocabulary.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

const tracked = git('ls-files').split('\n').filter(Boolean);
const topLevel = new Set(tracked.map((p) => p.split('/')[0]));

// Folders the restructure retired. The retired seams (records/, plans/) and the
// repo-managed harness hooks are gone; none may be tracked again.
const RETIRED_ROOT = ['records', 'plans', 'governance', 'hooks'];

// Every doc surface this repo owns, litellm/ included (issue #189). The runtime
// pins in test/litellm-runtime.test.mjs still guard litellm/README.md alongside
// the runtime it documents, but they check a different string set, so the folder
// is inside this pin too rather than exempt from it. CHANGELOG.md stays out
// because history is allowed to name what was.
//
// `*` in a git pathspec matches `/` too, so `docs/*.md` is the recursive form.
// `docs/**/*.md` is not -- it requires a directory in between, and silently
// skipped the two top-level docs/*.md files until #189 widened this list.
const DOC_GLOBS = ['AGENTS.md', 'README.md', 'docs/*.md', 'spec/*.md', 'litellm/*.md'];
const PRIVATE_STRINGS = new RegExp(`${PRIVATE_PATHS.source}|${PRIVATE_FOLDERS.source}`, 'i');

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

test('.claude/settings.json wires no hooks and names no private checkout', () => {
  const raw = fs.readFileSync(path.join(REPO, '.claude/settings.json'), 'utf8');
  assert.equal(PRIVATE_STRINGS.test(raw), false, 'settings.json names a private checkout');
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

test('the owned docs name no private-checkout path', () => {
  const docs = git('ls-files', '--', ...DOC_GLOBS).split('\n').filter(Boolean);
  assert.ok(docs.length > 5, `expected the doc set to be populated, got ${docs.length}`);
  const offenders = docs.filter((rel) =>
    PRIVATE_STRINGS.test(fs.readFileSync(path.join(REPO, rel), 'utf8')),
  );
  assert.deepEqual(offenders, [], `docs still name a private checkout: ${offenders}`);
});

test('the doc glob list reaches a top-level doc, not just a nested one', () => {
  // `docs/**/*.md` looked recursive and was not: it required a directory in
  // between, so docs/*.md sat unpinned. Without this the list can silently
  // narrow again and every assertion above it keeps passing.
  const docs = git('ls-files', '--', ...DOC_GLOBS).split('\n').filter(Boolean);
  const nesting = (rel) => rel.split('/').length;
  for (const dir of ['docs', 'spec', 'litellm']) {
    const under = docs.filter((rel) => rel.startsWith(`${dir}/`));
    assert.ok(under.length, `the doc set reaches nothing under ${dir}/`);
    assert.ok(
      under.some((rel) => nesting(rel) === 2),
      `the doc set skips top-level ${dir}/*.md files`,
    );
  }
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
const RETIRED_CHECKOUT_SCRIPTS = [
  'scripts/emit-daily-digest.ts',
  'launchd/com.chronicle.daily-digest.plist.template',
];

test('no retired-checkout script or job template is tracked', () => {
  const back = RETIRED_CHECKOUT_SCRIPTS.filter((rel) => tracked.includes(rel));
  assert.deepEqual(back, [], `a retired-checkout script is tracked again: ${back}`);
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

// --- Vocabulary sweep (issue #226, part of spec #215) ----------------------
//
// The shrink retired a whole vocabulary along with the surfaces: the private
// checkout Chronicle was the operator console for, the two sibling repos it
// named, and the private tracker's ticket ids. A word that survives is a
// pointer a reader outside this repo cannot follow, and an invitation to
// re-grow the thing it names.
//
// Scope: every git-tracked file, source and config included, not just docs.
//
// Exempt, deliberately:
//   - CHANGELOG.md: history is allowed to name what was.
//   - the removal pins themselves (this file, the vocabulary registry it reads,
//     and the suites that assert a retired route, CLI subcommand or env knob is
//     gone): a pin cannot forbid a word without spelling it.
//   - package-lock.json: generated, and its base64 integrity hashes contain
//     arbitrary letter runs.
//   - binary files: read as utf8 they are noise, and none carries prose.
const VOCAB_EXEMPT = new Set([
  'CHANGELOG.md',
  'package-lock.json',
  'test/repo-shape.test.mjs',
  'test/helpers/retired-vocabulary.mjs',
  'test/removed-routes.test.mjs',
  'test/cli-removed-inputs.test.mjs',
  'test/litellm-runtime.test.mjs',
]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|db)$/i;

// The ONE surviving literal, exempted BY VALUE rather than by file: this exact
// string is written into `chronicle_migrations` on every install that has run
// the usage-collapse backfill, so it is a schema value, not prose. Renaming it
// would re-run the backfill on live databases. Exempting the value (not
// server/db.ts, and not the suite that asserts it) keeps every other line in
// those files swept, and makes a SECOND such literal fail here rather than
// quietly inherit the allowance.
const SCHEMA_LITERALS = ['chi-286-collapse-replayed-usage'];
const stripSchemaLiterals = (line) =>
  SCHEMA_LITERALS.reduce((acc, lit) => acc.split(lit).join(''), line);

const sweepable = tracked.filter(
  (rel) => !VOCAB_EXEMPT.has(rel) && !BINARY.test(rel),
);

// The ONE way this file reads the swept set. `report(rel, src)` returns the
// offender strings for one file; unreadable files are skipped rather than
// throwing, so a stray binary the BINARY list does not know about cannot turn
// a real assertion into a crash.
function sweep(report, { skip = () => false } = {}) {
  const offenders = [];
  for (const rel of sweepable) {
    if (skip(rel)) continue;
    let src;
    try { src = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
    offenders.push(...report(rel, src));
  }
  return offenders;
}

test('the sweep covers source, config, spec and docs, not just docs', () => {
  // A sweep that quietly stopped scanning src/ or server/ would pass forever.
  for (const prefix of ['src/', 'server/', 'shared/', 'spec/', 'docs/', 'test/', 'scripts/', 'bin/']) {
    assert.ok(
      sweepable.some((rel) => rel.startsWith(prefix)),
      `the vocabulary sweep covers no file under ${prefix}`,
    );
  }
  assert.ok(
    sweepable.some((rel) => !rel.includes('/')),
    'the vocabulary sweep covers no repo-root config file',
  );
});

for (const { word, re } of RETIRED_WORDS) {
  test(`no tracked file outside the CHANGELOG names "${word}"`, () => {
    // Per LINE, so the failure names the line a reader has to go fix.
    const offenders = sweep((rel, src) =>
      src.split('\n').flatMap((line, i) =>
        re.test(stripSchemaLiterals(line)) ? [`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`] : [],
      ),
    );
    assert.deepEqual(offenders, [], `"${word}" is back:\n  ${offenders.join('\n  ')}`);
  });
}

test('no tracked file mounts or fetches a route the shrink removed', () => {
  // Quoted only: a bare `/jobs` in prose is a sentence, `'/jobs'` is a route.
  const offenders = sweep(
    (rel, src) =>
      RETIRED_ROUTE_PREFIXES.filter((prefix) =>
        new RegExp(`['"\`]${prefix.replace(/\//g, '\\/')}`).test(src),
      ).map((prefix) => `${rel} -> ${prefix}`),
    // It lists every removed route in order to assert each one 404s.
    { skip: (rel) => rel === 'test/removed-routes.test.mjs' },
  );
  assert.deepEqual(offenders, [], `a retired route is referenced again:\n  ${offenders.join('\n  ')}`);
});

test('no module the shrink deleted is tracked or imported', () => {
  const backOnDisk = RETIRED_MODULE_PATHS.filter((mod) =>
    tracked.some((rel) => rel.startsWith(mod)),
  );
  assert.deepEqual(backOnDisk, [], `a deleted module is tracked again: ${backOnDisk}`);

  const importers = sweep((rel, src) =>
    RETIRED_MODULE_PATHS.filter((mod) => {
      // Imports are written relative ('./gate/core.ts'), so match the tail.
      const tail = mod.replace(/^(server|src)\//, '').replace(/\//g, '\\/');
      return new RegExp(`from ['"][^'"]*${tail}`).test(src);
    }).map((mod) => `${rel} -> ${mod}`),
  );
  assert.deepEqual(importers, [], `a deleted module is imported again:\n  ${importers.join('\n  ')}`);
});
