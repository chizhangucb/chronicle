// Every exported symbol has a production caller (issue #265, finding F2 of the
// #183 audit).
//
// The audit found 50 exports in server/ and src/ that nothing outside test/
// imported: types used only by the module that declares them, helpers whose
// last caller was removed by the shrink, and `*Props` interfaces exported by
// habit. An export with no caller reads as an interface, so the next session
// widens a module's surface instead of its depth.
//
// The rule this file pins: an exported name is reachable from production code
// (server/, src/, shared/, scripts/, bin/), or it is listed below with the
// reason it is exported anyway: a module genuinely tested through its export
// surface (the audit's F21 judgment call), which also has to carry a note
// naming the test it is the seam for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir, exts = /\.(ts|tsx)$/) {
  const out = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(rel, exts));
    else if (exts.test(e.name)) out.push(rel);
  }
  return out;
}

// bin/ and scripts/ count as production: the launcher and the /ask runner are
// callers like any route is.
// Comments are not callers. A name mentioned in prose ("see ProjectPicker's
// list") would otherwise read as a reference and keep a dead export alive, so
// every file is scanned twice: `text` for the notes pin below, `code` with the
// comments taken out for the caller sweep. A `//` inside a string literal
// (`'http://...'`) is left alone, hence the quote count.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const at = line.search(/\/\//);
      if (at < 0) return line;
      const before = line.slice(0, at);
      const quoted = (ch) => (before.split(ch).length - 1) % 2 === 1;
      if (quoted("'") || quoted('"') || quoted('`')) return line;
      return before;
    })
    .join('\n');
}

const SOURCES = [
  ...sourceFiles('server'), ...sourceFiles('src'), ...sourceFiles('shared'),
  ...sourceFiles('scripts', /\.(ts|tsx|mjs)$/), ...sourceFiles('bin', /\.(ts|mjs)$/),
].map((rel) => {
  const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
  return { rel, text, code: stripComments(text) };
});

// The exported names a file declares: value declarations, type declarations
// and `export { … }` lists (aliased re-exports count under their public name).
function exportsOf(text) {
  const names = new Set();
  const decls = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g,
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
    /export\s+interface\s+([A-Za-z0-9_$]+)/g,
    /export\s+type\s+([A-Za-z0-9_$]+)\s*[=<]/g,
  ];
  for (const re of decls) for (const m of text.matchAll(re)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z0-9_$]+$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

// Exported for a test, on purpose: `file name` → why. Each entry is a module
// whose behaviour is reached directly instead of through a route, so the
// export IS the seam under test. Anything not listed has to have a production
// caller.
const TESTED_THROUGH_THE_EXPORT = {
  // The platform smoke (#200) runs on a CI runner against an installed
  // tarball, so `npm test` can never run it end to end. What it decides for
  // itself is exported and driven directly instead.
  'scripts/ci/platform-screenshots.mjs canonicalGlyphs': 'the glyph vocabulary read out of the design QA rubric',
  'scripts/ci/platform-screenshots.mjs hintFault': 'the verdict on the keyboard hint the Playback shot frames, asserted per OS',
  'scripts/ci/platform-screenshots.mjs monoStack': 'the shipped mono stack read out of the bundle, minified or not',
  'scripts/ci/platform-screenshots.mjs pickPlaybackSession': 'which session gets the Playback shot, chosen without a browser',
  'scripts/ci/platform-screenshots.mjs screenshotName': 'the per-OS file names two runners upload under',
  'scripts/ci/platform-smoke.mjs APP_DATA_DIRS': 'the Windows app-data roots the stray-write sweep watches',
  'scripts/ci/platform-smoke.mjs DEFAULT_PORT': 'the port the scan check holds, pinned against the launcher --help',
  'scripts/ci/platform-smoke.mjs appDataEntries': 'the %APPDATA% half of the ADR 0008 sweep, driven on a temp home',
  'scripts/ci/platform-smoke.mjs expectedDataDir': 'where ADR 0008 puts the data folder, asserted per environment',
  'scripts/ci/platform-smoke.mjs parseLaunchUrl': 'the launcher banner parse, asserted against real output',
  'scripts/ci/platform-smoke.mjs strayHomeEntries': 'the home sweep, driven over a planted temp home',
  'scripts/ci/platform-smoke.mjs writeClaudeTranscript': 'the planted transcript, run through the real Claude Code parser',
  'server/ask.ts ASK_HISTORY_MAX': 'ask history caps, asserted without a claude binary',
  'server/ask.ts ASK_HISTORY_ROWS': 'ask history caps, asserted without a claude binary',
  'server/ask.ts costBasisLabel': 'pure label helper, tested directly',
  'server/ask.ts parseHistory': 'pure history parser, tested directly',
  'server/ask.ts stripSqlComments': 'the SQL guard read through its comment stripper',
  'server/autosync.ts nextDelay': 'the debounce clamp, tested without wall-clock waits',
  'server/autosync.ts scheduleDebounced': 'the debounce state machine, driven directly',
  'server/security.ts scanText': 'the redaction core, exercised directly by the removal pin',
  'server/cache.ts cacheSize': 'cache eviction observed without a route',
  'server/db.ts closeDatabase': 'the lifecycle reopen path, driven directly by the seam pin',
  'server/db.ts isTombstoned': 'tombstone hygiene asserted against the DB directly',
  'server/demo/corpus.ts DEMO_DAYS': 'the demo corpus span the seeded assertions range over',
  'server/explore.ts ExploreQuery': 'the query shape the query-context pin reads',
  'server/explore.ts pickRollup': 'the rollup coarsening rule, tested directly',
  'server/parsers/claudeCode.ts collapseWorktree': 'worktree cwd collapsing, tested per path',
  'server/parsers/claudeCode.ts reduceCwd': 'cwd reduction over a transcript, tested per path',
  'server/parsers/cursor.ts clearCursorGlobalCache': 'test isolation between cursor fixtures',
  'server/parsers/cursor.ts cursorProjectSlug': 'the cursor path slug, tested per path',
  'server/planWindows.ts parseClaudePayload': 'the plan-window payload parser, tested offline',
  'server/scope.ts scopeClause': 'the scope fragment, asserted scope by scope',
  'shared/spend/anomaly.ts computeAnomaly': 'the headline anomaly rule, asserted over costed days',
  'shared/durations.ts ACTIVE_GAP_CAP_MS': 'the gap caps the duration tests assert against',
  'shared/durations.ts ENGAGED_GAP_CAP_MS': 'the gap caps the duration tests assert against',
  'shared/errors.ts ERROR_HEAD_CHARS': 'the error-head window the heuristic tests assert against',
  'shared/synthetic.ts SYNTHETIC_USER_RE': 'the synthetic-user pattern, asserted line by line',
  'src/charts/timeBuckets.ts hourKeyOf': 'bucket keys, tested across DST and month ends',
  'src/charts/timeBuckets.ts monthKeyOf': 'bucket keys, tested across DST and month ends',
  'src/reference/definitions.ts DEF_BY_ID': 'the definition registry, pinned id by id',
  'src/routes.ts KNOWN_ROUTES': 'the route table the not-found pin counts App.tsx against',
  'src/useResizable.ts nextWidthForKey': 'the arrow-key resize geometry, tested without a DOM',
  'src/writeToken.ts resetWriteToken': 'write-token reset between fetch-module tests',
};

function unreferenced() {
  const out = [];
  for (const { rel, code } of SOURCES) {
    for (const name of exportsOf(code)) {
      const used = SOURCES.some((s) => s.rel !== rel && new RegExp(`\\b${name}\\b`).test(s.code));
      if (!used) out.push(`${rel} ${name}`);
    }
  }
  return out.sort();
}

test('no export is reachable only from tests, unless it is listed as a test seam', () => {
  assert.deepEqual(unreferenced(), Object.keys(TESTED_THROUGH_THE_EXPORT).sort());
});

// The `//` comment blocks a file carries, each block joined into one string.
// A note is a block that names the export AND the test file it is the seam
// for, which is what separates a deliberate note from prose that happens to
// mention the name.
function commentBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split('\n')) {
    const comment = line.match(/^\s*\/\/ ?(.*)$/);
    if (comment) current = current === null ? comment[1] : `${current} ${comment[1]}`;
    else if (current !== null) { blocks.push(current); current = null; }
  }
  if (current !== null) blocks.push(current);
  return blocks;
}

test('every test-seam export carries its one-line note', () => {
  for (const entry of Object.keys(TESTED_THROUGH_THE_EXPORT)) {
    const [rel, name] = entry.split(' ');
    const blocks = commentBlocks(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    const noted = blocks.some((b) => new RegExp(`\\b${name}\\b`).test(b) && b.includes('test/'));
    assert.ok(noted, `${rel} should say in a comment which test ${name} is the seam for`);
  }
});
