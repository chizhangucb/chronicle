// The demo corpus.
//
// A zero-data user running `chronicle --demo` should see the WHOLE product, not
// populated ops panels wrapped around an empty console. That means synthetic
// sessions deep enough to make every surface real: 90d windows, medians, a
// budget projection, an anomaly baseline, subagents, errors, MCP calls.
//
// SPEC, NOT TRANSCRIPTS. D13 said to commit the transcripts under data/. The
// spec is committed instead, and the transcripts are generated at seed time,
// for one reason: a committed transcript carries a frozen DATE, so within a
// couple of months the demo would open on a console whose newest session is
// from last quarter, with every window empty and every baseline dead. Dates are
// the one thing a demo cannot fake after the fact. The two problems D13 was
// actually solving are both still solved: nothing imports across the
// scripts/-vs-server/ packaging boundary (this module ships compiled in
// dist-server), and the import cost is paid once per day, not once per launch
// (see seed.ts's cache).
//
// Everything here is invented. No real project names, paths, or prompts: this
// is a PUBLIC repo and the fixture floor is synthetic-only.

export interface DemoSessionSpec {
  sessionId: string;
  model: string;
  cwd: string;
  /** Days before today the session starts. 0 = a few hours ago. */
  daysAgo: number;
  promptText: string;
  turns: number;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
}

// Four invented projects, so the [project] axis, the busiest-projects table and
// the per-project error rates all have real spread.
const P_ATLAS = '/demo/atlas-api';
const P_ORCHARD = '/demo/orchard-web';
const P_BEACON = '/demo/beacon-cli';
const P_SLATE = '/demo/slate-docs';
const PROJECTS = [P_ATLAS, P_ORCHARD, P_BEACON, P_SLATE];

// Vendor spread, so the Spend tab's [project|provider] toggle and the routing
// table are not one flat bar. `mistral-large-2` is deliberately OFF-ROSTER and
// unpriced, which is what makes the routing-compliance row show something.
const MODELS = [
  'claude-opus-4-8',
  'claude-sonnet-5',
  'gpt-5',
  'gemini-2.5-pro',
  'mistral-large-2',
];

const PROMPTS = [
  'Add pagination to the search endpoint.',
  'Trace why the nightly export is timing out.',
  'Refactor the auth middleware into its own module.',
  'Write the migration for the new index.',
  'Investigate the flaky integration test.',
  'Draft the release notes for this milestone.',
  'Reduce the cold-start time on the worker.',
  'Add retries with backoff to the upstream client.',
  'Split the settings page into tabs.',
  'Audit the error handling in the ingest path.',
  'Cache the expensive aggregate query.',
  'Tighten the validation on the upload form.',
];

/** Deterministic PRNG. The demo must look the same every time it is built, or
 *  a screenshot taken today would not match the one taken tomorrow, and every
 *  visual regression would be noise. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How far back the corpus runs. 120 days so the 90d window is genuinely full
 *  and the month-to-date budget projection has a previous month behind it. */
export const DEMO_DAYS = 120;

/**
 * The corpus, as a deterministic list of session specs.
 *
 * Shape decisions that exist so specific surfaces are not empty:
 *  - Weekdays are busier than weekends, so Working Rhythm shows a pattern
 *    rather than a flat block.
 *  - Day 3 carries a deliberate spike (a long expensive session), so the
 *    anomaly tile has a flagged day and the Spend chart has a real peak.
 *  - Token magnitudes vary by an order of magnitude, so the median dash sits
 *    somewhere meaningful instead of on top of every bar.
 */
export function demoSessions(): DemoSessionSpec[] {
  const rnd = mulberry32(20260827);
  const out: DemoSessionSpec[] = [];
  let n = 0;

  for (let daysAgo = DEMO_DAYS; daysAgo >= 0; daysAgo--) {
    // Day-of-week from today, so the rhythm lands on real weekdays.
    const dow = new Date(Date.now() - daysAgo * 86_400_000).getDay();
    const weekend = dow === 0 || dow === 6;
    // A few quiet days entirely, so "active days" is smaller than "days" and
    // the $/active-day stat differs from $/day.
    if (rnd() < (weekend ? 0.6 : 0.12)) continue;

    const count = weekend ? 1 : 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      const spike = daysAgo === 3 && i === 0;
      const model = spike ? 'claude-opus-4-8' : MODELS[Math.floor(rnd() * MODELS.length)];
      const cwd = PROJECTS[Math.floor(rnd() * PROJECTS.length)];
      const scale = spike ? 9 : 0.4 + rnd() * 2.2;
      out.push({
        sessionId: `demo-${String(n).padStart(4, '0')}`,
        model,
        cwd,
        daysAgo,
        turns: spike ? 26 : 6 + Math.floor(rnd() * 12),
        promptText: PROMPTS[Math.floor(rnd() * PROMPTS.length)],
        usage: {
          input_tokens: Math.round(2200 * scale),
          output_tokens: Math.round(900 * scale),
          cache_read_input_tokens: rnd() < 0.7 ? Math.round(1800 * scale) : 0,
        },
      });
      n++;
    }
  }
  return out;
}

/** A stable fingerprint of the corpus SHAPE (not its dates), used as part of
 *  the seed cache key so an edit to this file rebuilds rather than serving a
 *  stale demo DB. */
// v2 (issue #186): the demo's proxy spend log moved out of the retired
// checkout's `litellm/` to
// `litellm/` under the demo dir, following the standalone spend-log default.
export const DEMO_CORPUS_VERSION = 'v2';
