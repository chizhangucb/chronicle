// The paired-tool_use join has one home (issue #378).
//
// The rule that finds which tool_use a tool_result belongs to — same session,
// same `tool_use_id`, earliest matching row — was hand-written in every engine
// that pairs: Explore's error rows and its error rollup, Content's tool-result
// attribution, Waste's repeat file reads. Four copies is four places for the
// pairing to drift, the way the error heuristic used to drift before
// shared/errors.ts owned it. The join now comes from server/scope.ts's
// pairedToolJoin and every engine composes it.
//
// These read the tracked sources (like test/query-context-single-home.test.mjs)
// because "written once" is a property no engine's output can show, and a
// hand-written copy is one paste away from coming back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, tracked } from './helpers/tracked-files.mjs';

const SERVER_TS = tracked.filter((rel) => rel.startsWith('server/') && rel.endsWith('.ts'));

// The one module allowed to spell the join out.
const HOME = 'server/scope.ts';

// The engines that pair a result back to its use. The client's live-session
// error drill-in pairs over in-memory events, not SQL, so it is not a caller.
const PAIRING_ENGINES = ['server/explore.ts', 'server/content.ts', 'server/waste.ts'];

// A SQL self-join on the id: `<alias>.tool_use_id = <alias>.tool_use_id`, the
// shape every hand-written copy had. Prose about the join is not a copy of it,
// so comment lines are swept out first (server/schema.ts's index comment
// describes what the builder needs without spelling a query out).
const HAND_WRITTEN = /\w+\.tool_use_id\s*=\s*\w+\.tool_use_id/;
const code = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|--|\*)/.test(l)).join('\n');

test('the pairing join is written once, in the query-context module', () => {
  const offenders = SERVER_TS
    .filter((rel) => rel !== HOME)
    .filter((rel) => HAND_WRITTEN.test(code(read(rel))));
  assert.deepEqual(offenders, [], 'these files hand-write the paired-tool_use join instead of taking it from server/scope.ts');
});

test('the builder is declared once, and no module re-exports it', () => {
  const declares = SERVER_TS.filter((rel) => /(?:^|\n)\s*export function pairedToolJoin\b/.test(read(rel)));
  assert.deepEqual(declares, [HOME], 'pairedToolJoin should be declared only in server/scope.ts');
  const reExports = SERVER_TS
    .filter((rel) => rel !== HOME)
    .filter((rel) => /export\s*\{[^}]*\bpairedToolJoin\b[^}]*\}/.test(read(rel)));
  assert.deepEqual(reExports, [], 'a re-export is a second home wearing the first one\'s clothes');
});

for (const rel of PAIRING_ENGINES) {
  test(`${rel} pairs through the one builder`, () => {
    const src = read(rel);
    assert.match(src, /import \{[^}]*\bpairedToolJoin\b[^}]*\} from '\.\/scope\.ts'/,
      `${rel} should import pairedToolJoin from server/scope.ts`);
    assert.match(src, /pairedToolJoin\(\{/, `${rel} should compose the builder into its query`);
  });
}

// Explore pairs TWICE (the ranked error rows and the error rollup), so a
// per-file check would pass with one of them still hand-written.
test('every paired-tool_use join in the engines comes from a builder call', () => {
  const calls = PAIRING_ENGINES
    .map((rel) => (read(rel).match(/pairedToolJoin\(\{/g) ?? []).length)
    .reduce((n, c) => n + c, 0);
  assert.equal(calls, 4, 'Explore pairs twice, Content and Waste once each');
});

// The join is only affordable because of the index it drives: without it
// SQLite scans every message of the session to find the paired row. The rule
// and the index that makes it cheap have to stay legible together.
test('the builder names the index it relies on', () => {
  const home = read(HOME);
  const doc = /((?:\/\/[^\n]*\n)+)export function pairedToolJoin\b/.exec(home);
  assert.ok(doc, 'pairedToolJoin carries a doc comment');
  assert.match(doc[1], /idx_messages_tooluse/, 'the comment should name idx_messages_tooluse');
  assert.match(read('server/schema.ts'), /CREATE INDEX IF NOT EXISTS idx_messages_tooluse\b/,
    'the index the comment names should still be the one the schema declares');
});
