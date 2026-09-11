// Removal pins for the view log (issue #297, part of #294).
//
// Chronicle kept a local record of which of its own surfaces were looked at.
// It is gone: module, route, client hook, Settings block and reference entry
// deleted, its table dropped by migration, its cache exception and its boot
// prune removed.
//
// Two pins already exist elsewhere and are not repeated here: the deleted
// modules and suites, and the unmounted route, are swept by the retired
// vocabulary registry (test/helpers/retired-vocabulary.mjs, read by
// test/repo-shape.test.mjs), and the route is asserted live at 404 in
// test/removed-routes.test.mjs. That sweep matches quoted route prefixes and
// import statements, so it does not see a client call built from
// `/api/...`, a css block, a boot-time call, or prose. Those are what this
// file holds, alongside the one thing no source read can answer: the migration
// running against a data folder seeded the way an older Chronicle left it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Every spelling the feature ever had, and nothing else. Two arms, because one
// regex cannot do both jobs:
//   - `view_log` (the table), `view-log` (the route, the css) and `view log`
//     (the prose), case-insensitive but anchored on a word boundary, so
//     "overview logic" and "review log" are not the feature coming back;
//   - `ViewLog` camelCase, case-SENSITIVE, which is what makes it safe
//     mid-identifier: `useViewLog`, `mountViewLog`, `pruneViewLog` and
//     `ViewLogSummary` all sit inside a longer word.
const SPELLINGS = [/\bview[-_ ]?log/i, /ViewLog/];
const namesTheFeature = (text) => SPELLINGS.some((re) => re.test(text));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-viewlog-'));
let dbModule;

before(async () => {
  // A data folder written by a Chronicle that still had the feature: the table,
  // its index and a row in it.
  const seed = new DatabaseSync(path.join(dir, 'chronicle.db'));
  seed.exec(`
    CREATE TABLE view_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, route TEXT NOT NULL, event TEXT NOT NULL, detail TEXT,
      dwell_ms INTEGER, actor_client TEXT, actor_server TEXT, ua TEXT, gesture INTEGER
    );
    CREATE INDEX idx_view_log_ts ON view_log(ts);
    INSERT INTO view_log (ts, route, event) VALUES ('2026-09-01T00:00:00.000Z', '/session/:id', 'visit');
  `);
  seed.close();
  process.env.CHRONICLE_DATA_DIR = dir;
  dbModule = await import('../server/db.ts');
  dbModule.openDatabase(dir); // the drop runs here (#275), not on import
});

after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const objectNames = () =>
  dbModule.getDb().prepare('SELECT name FROM sqlite_master').all().map((r) => r.name);

test('booting on an upgraded data folder drops the table and its index', () => {
  const left = objectNames().filter(namesTheFeature);
  assert.deepEqual(left, [], `an upgraded data folder still carries ${left.join(', ')}`);
});

test('the drop takes nothing else with it', () => {
  const names = objectNames();
  for (const t of ['projects', 'sessions', 'messages', 'session_tombstones', 'chronicle_migrations']) {
    assert.ok(names.includes(t), `the migration removed ${t}`);
  }
});

test("Ask's read-only handle sees no such table", () => {
  // /ask opens the same file SELECT-only (scripts/ask-db-mcp.ts). What it can
  // see is the operator-visible half of the drop.
  const handle = new DatabaseSync(path.join(dir, 'chronicle.db'), { readOnly: true });
  try {
    const seen = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all().map((r) => r.name).filter(namesTheFeature);
    assert.deepEqual(seen, [], `Ask can still query ${seen.join(', ')}`);
  } finally {
    handle.close();
  }
});

test('WAL stays on', () => {
  const row = dbModule.getDb().prepare('PRAGMA journal_mode').get();
  assert.equal(String(Object.values(row)[0]).toLowerCase(), 'wal');
});

test('the WAL comment stands on the SQLite-backed parsers, not on the view log', () => {
  // WAL was justified by the view log's per-navigation write. That write is
  // gone and WAL is not, so the comment has to carry a reason that outlives it,
  // or the next reader turns WAL off for want of one.
  const lines = read('server/db.ts').split('\n');
  const at = lines.findIndex((l) => l.includes("PRAGMA journal_mode = WAL"));
  assert.ok(at > 0, 'server/db.ts no longer turns WAL on');
  const comment = [];
  for (let i = at - 1; i >= 0 && lines[i].trim().startsWith('//'); i--) comment.unshift(lines[i]);
  const text = comment.join('\n');
  assert.match(text, /parser/i, 'the WAL comment does not name the parsers as its reason');
  assert.equal(namesTheFeature(text), false, 'the WAL comment still rests on the view log');
});

test('the boot mounts no such route and runs no retention pass', () => {
  const src = read('server/api.ts');
  assert.equal(namesTheFeature(src), false, 'server/api.ts still reaches for the view log');
  // Everything createApp() calls. Mounting a router is the whole of it — a
  // rolling 180-day DELETE over the recorded rows used to sit between the
  // mounts. Auto-sync moved out to the entry points with #275, so a boot call
  // of any kind in here is new.
  const boot = src.split('\n')
    .filter((l) => /^\s*[a-z][\w.]*\(.*\);$/.test(l))
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('mount') && !l.startsWith('api.use') && !l.startsWith('useDatabase('));
  assert.deepEqual(boot, [], `createApp does more than mount: ${boot.join(' ')}`);
  // And the entry that does start auto-sync runs no retention pass either.
  assert.equal(namesTheFeature(read('server/standalone.ts')), false, 'the standalone entry reaches for the view log');
});

test('the cache carries no invalidation exception', () => {
  // The exception was load-bearing and documented in two places: the module
  // that took it, and the architecture doc that advertised it.
  const doc = read('docs/contributing/architecture.md');
  assert.equal(namesTheFeature(doc), false, 'the architecture doc still names the view log');
  assert.equal(/exempt from invalidation/i.test(doc), false, 'the cache still advertises an exemption');
  assert.match(doc, /generation-keyed/, 'the cache line itself went missing');
});

test('the client carries no fetch, hook or Settings block for it', () => {
  for (const rel of ['src/api.ts', 'src/App.tsx', 'src/styles.css']) {
    assert.equal(namesTheFeature(read(rel)), false, `${rel} still names the view log`);
  }
  assert.equal(
    /settings-block/.test(read('src/App.tsx')), false,
    "the view-log block's container survives in Settings",
  );
});

test('the reference registry defines no view log', async () => {
  const { DEF_BY_ID, DEFINITIONS } = await import('../src/reference/definitions.ts');
  assert.equal(DEF_BY_ID.has('settings.view-log'), false);
  const named = DEFINITIONS.filter((d) => namesTheFeature(`${d.id} ${d.title} ${d.plain({})} ${d.tech?.({}) ?? ''}`));
  assert.deepEqual(named.map((d) => d.id), [], 'a definition still describes the view log');
});

test('the glossary drops the entry and Transcript reserves no "log"', () => {
  const ctx = read('CONTEXT.md');
  assert.equal(namesTheFeature(ctx), false, 'CONTEXT.md still defines or cites the view log');
  // Entries are `**Term**:` at the start of a line.
  const transcript = ctx.split('\n**').find((b) => b.startsWith('Transcript**:'));
  assert.ok(transcript, 'CONTEXT.md lost the Transcript entry');
  const avoid = transcript.split('\n').find((l) => l.startsWith('_Avoid_:')) ?? '';
  assert.equal(/\blog\b/i.test(avoid), false, `Transcript still reserves "log": ${avoid}`);
  assert.match(avoid, /\bhistory\b/, 'Transcript lost the rest of its avoid list');
});

test('the surface contract lists no such block in the Settings modal', () => {
  // The contract's own pin inventory names this suite, so the section is what
  // is swept, not the whole file.
  const contract = read('spec/surface-contract.md');
  const at = contract.indexOf('### Settings modal');
  assert.ok(at > 0, 'the surface contract lost its Settings modal section');
  // Bounded by the NEXT heading of any level. The section after it is the pin
  // inventory, whose row cites this file by a name the spelling arms match, so
  // an over-long slice would fail on its own citation.
  const next = contract.indexOf('\n#', at + 1);
  const section = contract.slice(at, next === -1 ? contract.length : next);
  assert.equal(namesTheFeature(section), false, 'Settings still contracts a view-log block');
  assert.match(section, /Ask \(experimental\)/, 'the section lost the toggle rows it does contract');
});
