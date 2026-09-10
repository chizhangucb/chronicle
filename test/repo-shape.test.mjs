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
import fs from 'node:fs';
import path from 'node:path';
import {
  PRIVATE_PATHS,
  PRIVATE_FOLDERS,
  LEGACY_LAYOUT,
  PRIVATE_LOCATION,
  FOREIGN_CONSUMER,
  RETIRED_WORDS,
  RETIRED_PHRASES,
  RETIRED_ROUTE_PREFIXES,
  RETIRED_MODULE_PATHS,
} from './helpers/retired-vocabulary.mjs';
import { REPO, git, tracked, BINARY } from './helpers/tracked-files.mjs';

const topLevel = new Set(tracked.map((p) => p.split('/')[0]));

// Folders the restructure retired. The retired seams (records/, plans/) and the
// repo-managed harness hooks are gone; none may be tracked again.
const RETIRED_ROOT = ['records', 'plans', 'governance', 'hooks'];

// Every doc surface this repo owns. CHANGELOG.md stays out because history is
// allowed to name what was.
//
// `*` in a git pathspec matches `/` too, so `docs/*.md` is the recursive form.
// `docs/**/*.md` is not -- it requires a directory in between, and silently
// skipped the two top-level docs/*.md files until #189 widened this list.
const DOC_GLOBS = ['AGENTS.md', 'README.md', 'docs/*.md', 'spec/*.md'];

// The private checkout, spelled every way a tracked file could point at it: the
// paths themselves, the folders, the pre-move layout its files sat in, and the
// `hub `path`` location header. The last two used to be read by the LiteLLM
// runtime pins over litellm/'s runbook; #296 deleted that suite with the spine,
// so the owned-doc sweep carries them now rather than letting them lapse.
const PRIVATE_STRINGS = new RegExp(
  [PRIVATE_PATHS, PRIVATE_FOLDERS, LEGACY_LAYOUT, PRIVATE_LOCATION, FOREIGN_CONSUMER]
    .map((re) => re.source)
    .join('|'),
  'i',
);

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
  for (const dir of ['docs', 'spec']) {
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

// The shrink (spec #215) left `scripts/` holding only Chronicle's own tooling,
// and took every dormant job template out of the published tarball. #296 took
// the last template out of the repo altogether, with the proxy spine it
// scheduled and the installer that filled it, so there is no exclusion left to
// keep: the pin is that no template is tracked anywhere and that the npm
// `files` list never starts shipping one again.
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
  const strays = tracked.filter((rel) => /\.(plist|plist\.template)$|crontab/.test(rel));
  assert.deepEqual(strays, [], `a job template is tracked again: ${strays}`);
});

// --- The proxy spine (issue #296, part of spec #294) -----------------------
//
// Chronicle stopped reading the LiteLLM proxy's spend log in #217, and the
// spine outlived its reader: a Python proxy, its launchd template, the
// installer that filled that template, and two suites whose whole subject was
// the proxy. Nothing in the product reached any of it.
//
// `npx chronicle-cli` and this repo's CI need Node and nothing else. These
// pins are what "and nothing else" means, so the spine cannot settle back in
// one file at a time.
const RETIRED_SPINE_PATHS = [
  'litellm/',
  'launchd/',
  'scripts/install-jobs.mjs',
  'test/litellm-guards.test.mjs',
  'test/litellm-runtime.test.mjs',
];

test('no proxy-spine file is tracked', () => {
  const back = RETIRED_SPINE_PATHS.filter((spine) =>
    tracked.some((rel) => rel === spine || rel.startsWith(spine)),
  );
  assert.deepEqual(back, [], `the proxy spine is tracked again: ${back}`);
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
//   - binary files (the BINARY list in test/helpers/tracked-files.mjs).
const VOCAB_EXEMPT = new Set([
  'CHANGELOG.md',
  'package-lock.json',
  'test/repo-shape.test.mjs',
  'test/helpers/retired-vocabulary.mjs',
  'test/removed-routes.test.mjs',
  'test/cli-removed-inputs.test.mjs',
]);

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

// One word, one file. docs/agents/design-audit-2026-09-04.md is a dated audit
// record: spec #294 is cut from its findings and cites them by number, so F18
// cannot be edited out of it. Exempting the WORD there (rather than the file,
// as VOCAB_EXEMPT would) keeps every other retired word forbidden in it, same
// principle as SCHEMA_LITERALS above.
const WORD_EXEMPT = new Map([
  ['causality', 'docs/agents/design-audit-2026-09-04.md'],
]);
// Blanks the exempt word's one file for that word only. Applied inside the
// report (rather than as a sweep-wide filter) so the sweepable set the other
// pins read stays exactly the same set.
const stripExemptFile = (word, rel, line) =>
  (WORD_EXEMPT.get(word) === rel ? '' : line);

// The glossary's `_Avoid_:` lines are the one place a retired word or phrase is
// supposed to appear: CONTEXT.md cannot say which one lost without naming it.
// Same principle as VOCAB_EXEMPT above, scoped to the ONE file AND to the line
// inside it, so every other line of the glossary is swept normally and no other
// file can hide a retired word behind an `_Avoid_:` prefix.
const GLOSSARY = 'CONTEXT.md';
const stripAvoidLine = (rel, line) =>
  (rel === GLOSSARY && /^_Avoid_:/.test(line.trim()) ? '' : line);

for (const { word, re } of RETIRED_WORDS) {
  test(`no tracked file outside the CHANGELOG names "${word}"`, () => {
    // Per LINE, so the failure names the line a reader has to go fix.
    const offenders = sweep((rel, src) =>
      src.split('\n').flatMap((line, i) =>
        re.test(stripExemptFile(word, rel, stripAvoidLine(rel, stripSchemaLiterals(line))))
          ? [`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`]
          : [],
      ),
    );
    assert.deepEqual(offenders, [], `"${word}" is back:\n  ${offenders.join('\n  ')}`);
  });
}

for (const { phrase, re } of RETIRED_PHRASES) {
  test(`no tracked file outside the CHANGELOG says "${phrase}"`, () => {
    const offenders = sweep((rel, src) =>
      src.split('\n').flatMap((line, i) =>
        re.test(stripAvoidLine(rel, stripSchemaLiterals(line)))
          ? [`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`]
          : [],
      ),
    );
    assert.deepEqual(offenders, [], `"${phrase}" is back:\n  ${offenders.join('\n  ')}`);
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
