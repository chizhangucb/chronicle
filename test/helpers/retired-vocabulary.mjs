// The ONE definition of the vocabulary the shrink retired (spec #215, issue
// #226), read by the repo-shape pins (test/repo-shape.test.mjs).
//
// It was written for two callers because two copies drifted apart once already
// (issue #186). The second caller was the proxy runtime suite, deleted with the
// spine it pinned (#296). Every pattern only that suite read is still forbidden
// somewhere, one by one, so this note can be cited as coverage:
//
//   - LEGACY_LAYOUT `scripts/litellm` and `scripts/tests/test_litellm` -> the
//     `litellm` sweep in test/repo-shape.test.mjs.
//   - LEGACY_LAYOUT `scripts/tests/test_lane_c` -> the `scripts/tests` sweep
//     there, added because that one alternative matched nothing else.
//   - PRIVATE_LOCATION ``hub `scripts/...` `` -> RETIRED_WORDS `hub` below:
//     every string it could match carries the word.
//   - FOREIGN_CONSUMER `varde` -> RETIRED_WORDS `varde` below; its
//     `aggregator/sources` half had no such twin, so it moved into
//     RETIRED_WORDS itself as `foreign consumer path`.
//
// It stays its own file on one caller because it is the registry, not the pin:
// repo-shape exempts it BY PATH from its own vocabulary sweep, and a registry a
// pin must not read itself is easier to keep honest as a file than as a block
// inside the file doing the reading.

/** Paths into the author's private checkout, and the machine-only dirs the
 *  runtime used to reach. No tracked file may name one. */
export const PRIVATE_PATHS = /chizhang-2|AIOS_HUB|CHRONICLE_HUB|\.aios\/|\.secrets\//i;

/** The retired checkout's own folders, named as a path a reader could follow. */
export const PRIVATE_FOLDERS = /governance\//i;

/** Ticket ids from the private tracker. A reader who is not the author cannot
 *  open one, so prose citing them is prose that dead-ends (issue #187).
 *  Case-insensitive and separator-tolerant: `chi286Backfill` and
 *  `chi-286-...` dead-end exactly as `CHI-286` does. */
export const PRIVATE_TICKET = /\bchi[-_]?\d{2,}/i;

/** The product words the shrink retired (spec #215 story 20): the operator
 *  console Chronicle was carved out of, the two sibling repos, and the private
 *  tracker's ticket ids. Case-insensitive; `github` is not a hit because the
 *  pattern is word-anchored.
 *
 *  `causality` joined them with the feature (spec #294, issue #298): the
 *  heuristic read-to-change links are gone from the engine, the route and
 *  Playback, so a tracked file naming them either describes a surface the
 *  operator cannot reach or is about to re-grow one. */
export const RETIRED_WORDS = [
  { word: 'hub', re: /\bhubs?\b/i },
  { word: 'nisse', re: /\bnisse\b/i },
  { word: 'varde', re: /\bvarde\b/i },
  // The sibling repo named as a path rather than a word. It was swept over
  // litellm/ only until the proxy spine went (#296); the coupling it implies is
  // not ours to document anywhere, so it is swept repo-wide here instead.
  { word: 'foreign consumer path', re: /aggregator\/sources/i },
  { word: 'AIOS', re: /\baios\b/i },
  { word: 'causality', re: /\bcausality\b/i },
  { word: 'private ticket id', re: PRIVATE_TICKET },
];

/** Phrases CONTEXT.md (issue #181) retired, landed by issue #256. Unlike
 *  RETIRED_WORDS these are phrase-scoped, because the bare words survive in the
 *  senses the glossary keeps: `window` is still the plan window and the context
 *  window (and the browser's own `window`), and `Playback` carries no `replay`.
 *
 *  `replay` is the one absolute: nothing in the product is a replay. Playback
 *  and time travel own those meanings, and the parsers' repeated usage lines own
 *  theirs. The single surviving spelling is the frozen migration name, stripped
 *  by SCHEMA_LITERALS before the sweep reads a line. */
export const RETIRED_PHRASES = [
  { phrase: 'replay', re: /\breplay/i },
  { phrase: 'window toggle', re: /\bwindow toggle\b/i },
  { phrase: 'rangebar as a name', re: /\b(?:project|the|a|shared) rangebar\b/ },
  { phrase: 'windowed usage', re: /\bwindowed (?:usage|cells|billed)\b/i },
  { phrase: 'in-window', re: /\bin-window\b/i },
];

/** Route prefixes the shrink unmounted. A tracked file that mounts or fetches
 *  one has re-grown a surface (routes are pinned live in
 *  test/removed-routes.test.mjs; this is the source-level pin). */
export const RETIRED_ROUTE_PREFIXES = [
  '/briefing', '/launch/', '/memory/scope-suggest', '/routing', '/gate/',
  '/modules', '/jobs', '/records', '/proxy-lane', '/machine-sessions',
];

/** Server and client modules the shrink deleted, plus the causality engine
 *  #298 deleted. None may come back. */
export const RETIRED_MODULE_PATHS = [
  'server/causality',
  'server/hub/', 'server/gate/', 'server/briefing', 'server/launch',
  'server/machineSessions', 'server/proxyLane', 'server/scopeSuggest',
  'src/ModulesPage', 'src/SafetyPage', 'src/JobsPage', 'src/BriefingPage',
  'src/MemoryPage', 'src/RecordsPage', 'src/gateToken',
];
