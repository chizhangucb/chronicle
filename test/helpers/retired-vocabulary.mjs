// The ONE definition of the vocabulary the shrink retired (spec #215, issue
// #226), shared by the repo-shape pins (test/repo-shape.test.mjs) and the
// LiteLLM runtime pins (test/litellm-runtime.test.mjs).
//
// Two copies drifted apart once already: the runtime copy did not catch
// `scripts/litellm/`, so live private-checkout paths sat in a contract file
// while its guard test passed (issue #186). One definition, two callers.

/** Paths into the author's private checkout, and the machine-only dirs the
 *  runtime used to reach. No tracked file may name one. */
export const PRIVATE_PATHS = /chizhang-2|AIOS_HUB|CHRONICLE_HUB|\.aios\/|\.secrets\//i;

/** The retired checkout's own folders, named as a path a reader could follow. */
export const PRIVATE_FOLDERS = /governance\//i;

/** Where the LiteLLM files used to live inside that checkout, plus test paths
 *  that moved with them. A doc still citing `scripts/litellm/config.yaml` is
 *  pointing at a file that is not there. */
export const LEGACY_LAYOUT = /scripts\/litellm|scripts\/tests\/test_(litellm|lane_c)/i;

/** `hub `scripts/...`` style location headers. */
export const PRIVATE_LOCATION = /\bhub\s+`/i;

/** Ticket ids from the private tracker. A reader who is not the author cannot
 *  open one, so prose citing them is prose that dead-ends (issue #187).
 *  Case-insensitive and separator-tolerant: `chi286Backfill` and
 *  `chi-286-...` dead-end exactly as `CHI-286` does. */
export const PRIVATE_TICKET = /\bchi[-_]?\d{2,}/i;

/** A sibling repo named as a consumer of this repo's data. Nobody outside can
 *  follow the reference, and the coupling it implies is not ours to document. */
export const FOREIGN_CONSUMER = /\bvarde\b|aggregator\/sources/i;

/** The product words the shrink retired (spec #215 story 20): the operator
 *  console Chronicle was carved out of, the two sibling repos, and the private
 *  tracker's ticket ids. Case-insensitive; `github` is not a hit because the
 *  pattern is word-anchored. */
export const RETIRED_WORDS = [
  { word: 'hub', re: /\bhubs?\b/i },
  { word: 'nisse', re: /\bnisse\b/i },
  { word: 'varde', re: /\bvarde\b/i },
  { word: 'AIOS', re: /\baios\b/i },
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

/** Server and client modules the shrink deleted. None may come back. */
export const RETIRED_MODULE_PATHS = [
  'server/hub/', 'server/gate/', 'server/briefing', 'server/launch',
  'server/machineSessions', 'server/proxyLane', 'server/scopeSuggest',
  'src/ModulesPage', 'src/SafetyPage', 'src/JobsPage', 'src/BriefingPage',
  'src/MemoryPage', 'src/RecordsPage', 'src/gateToken',
];
