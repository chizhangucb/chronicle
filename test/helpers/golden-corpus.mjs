// Deterministic corpus + normalizer for the route golden (ticket #304).
//
// The golden pins every engine's JSON against the pre-slice commit: the same
// corpus, the same ranges, the same numbers. Determinism comes from two
// choices: the anchor is LOCAL NOON OF THE MOST RECENT MONDAY (so no fixture
// straddles a local midnight whatever time of day CI starts, AND the run's
// weekday is fixed: a moving weekday moves weekly bucket boundaries and the
// hour-of-day heatmap's `dow` rows, neither of which a day offset can
// normalize away), and every timestamp is an offset from that anchor.
// `normalizeGolden` then rewrites the run's real dates back to anchor-relative
// markers, so the committed fixture stays valid tomorrow.
const HOUR = 3600000;
const DAY = 86400000;
const MODEL = 'claude-sonnet-5';
const OPUS = 'claude-opus-5';

// Local noon on the most recent Monday — see the file header for why local,
// and why a fixed weekday. At most 6.5 days back, which every range in the
// matrix clears (the shortest is the project route's 30d, the only case that
// reads the real clock rather than the pinned anchor).
export function anchorNow() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

const iso = (ms) => new Date(ms).toISOString();

// Assistant turns with token columns, spaced so agent_active_ms clears the
// noise gate (server/noiseGate.ts) for every non-minor fixture.
function turns(now, offsets, opts = {}) {
  const model = opts.model ?? MODEL;
  return offsets.map((offset, i) => ({
    kind: 'assistant',
    model,
    ts: iso(now + offset),
    text: `assistant reply ${i} with enough text to calibrate against`,
    input_tokens: opts.input ?? 100,
    output_tokens: opts.output ?? 20,
    cache_read_tokens: opts.cacheRead ?? 50,
    cache_w5m_tokens: opts.cw5m ?? 10,
    cache_w1h_tokens: opts.cw1h ?? 0,
  }));
}

function usage(cells) {
  return JSON.stringify(cells);
}

// Seeds two projects and five sessions covering every gate the engines apply:
// a fully-in-range session, one that SPANS the Today cutoff, an old one
// (outside 7d, inside 90d), a minor one (noise-gated out of every aggregate)
// and a second project so scope=project has something to narrow to.
export function buildCorpus(dbModule, now) {
  const { upsertProject, replaceSession } = dbModule;
  const alpha = upsertProject('/tmp/golden-alpha');
  const beta = upsertProject('/tmp/golden-beta');

  // today: 3h..30min before the anchor, wholly inside every range.
  replaceSession(
    { id: 'g-today', project_id: alpha.id, source: 'claude-code', file_path: '/tmp/g-today.jsonl',
      started_at: iso(now - 3 * HOUR), ended_at: iso(now - 30 * 60000),
      summary: 'today session', first_prompt: 'do the thing',
      usage: usage({ [MODEL]: { input: 1200, output: 240, cacheRead: 600, cacheWrite5m: 120, cacheWrite1h: 0 } }) },
    [
      { kind: 'user', text: 'do the thing', ts: iso(now - 3 * HOUR) },
      ...turns(now, [-2.8 * HOUR, -2.5 * HOUR, -2 * HOUR, -1.5 * HOUR, -HOUR, -50 * 60000]),
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 't1', tool_input: JSON.stringify({ file_path: '/src/a.ts' }), ts: iso(now - 49 * 60000) },
      { kind: 'tool_result', tool_use_id: 't1', text: 'file contents of a', ts: iso(now - 48 * 60000) },
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 't2', tool_input: JSON.stringify({ file_path: '/src/a.ts' }), ts: iso(now - 47 * 60000) },
      { kind: 'tool_result', tool_use_id: 't2', text: 'file contents of a', ts: iso(now - 46 * 60000) },
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 't3', tool_input: JSON.stringify({ command: 'npm test' }), ts: iso(now - 45 * 60000) },
      { kind: 'tool_result', tool_use_id: 't3', text: 'Error: command failed with exit code 1', ts: iso(now - 44 * 60000) },
      { kind: 'thinking', text: 'thinking about the failure at length', ts: iso(now - 43 * 60000) },
      ...turns(now, [-40 * 60000, -35 * 60000], { model: OPUS, input: 90000, output: 4000, cacheRead: 70000 }),
    ],
  );

  // spanner: started 30h before the anchor (outside a 1-day range) but ran
  // into it — half its messages before the cutoff, half after.
  replaceSession(
    { id: 'g-span', project_id: alpha.id, source: 'codex', file_path: '/tmp/g-span.jsonl',
      started_at: iso(now - 30 * HOUR), ended_at: iso(now - 2 * HOUR),
      name: 'the spanning session',
      usage: usage({ [MODEL]: { input: 2000, output: 400, cacheRead: 1000, cacheWrite5m: 200, cacheWrite1h: 50 } }) },
    [
      ...turns(now, [-29 * HOUR, -28 * HOUR, -27 * HOUR, -26 * HOUR, -25.5 * HOUR, -25 * HOUR]),
      ...turns(now, [-20 * HOUR, -16 * HOUR, -10 * HOUR, -8 * HOUR, -5 * HOUR, -3 * HOUR]),
    ],
  );

  // old: 40 days back — outside 7d/30d, inside 90d and All.
  replaceSession(
    { id: 'g-old', project_id: beta.id, source: 'cursor', file_path: '/tmp/g-old.jsonl',
      started_at: iso(now - 40 * DAY), ended_at: iso(now - 40 * DAY + 2 * HOUR),
      usage: usage({ [OPUS]: { input: 5000, output: 900, cacheRead: 2500, cacheWrite5m: 300, cacheWrite1h: 0 } }) },
    [
      ...turns(now - 40 * DAY, [0, 10 * 60000, 20 * 60000, 30 * 60000, 40 * 60000, 50 * 60000, 60 * 60000, 70 * 60000, 80 * 60000, 90 * 60000, 100 * 60000, 110 * 60000], { model: OPUS }),
    ],
  );

  // A second in-range session on the beta project, so project scope differs
  // from all scope on every aggregate.
  replaceSession(
    { id: 'g-beta', project_id: beta.id, source: 'opencode', file_path: '/tmp/g-beta.jsonl',
      started_at: iso(now - 6 * HOUR), ended_at: iso(now - 4 * HOUR),
      usage: usage({ [MODEL]: { input: 800, output: 160, cacheRead: 400, cacheWrite5m: 900, cacheWrite1h: 0 } }) },
    [
      { kind: 'user', text: 'beta prompt', ts: iso(now - 6 * HOUR) },
      ...turns(now, [-5.8 * HOUR, -5.5 * HOUR, -5.2 * HOUR, -5 * HOUR, -4.8 * HOUR, -4.5 * HOUR, -4.3 * HOUR]),
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'b1', tool_input: JSON.stringify({ file_path: '/src/b.ts' }), ts: iso(now - 4.2 * HOUR) },
      { kind: 'tool_result', tool_use_id: 'b1', text: 'contents of b', ts: iso(now - 4.1 * HOUR) },
      { kind: 'tool_use', tool_name: 'Read', tool_use_id: 'b2', tool_input: JSON.stringify({ file_path: '/src/b.ts' }), ts: iso(now - 4.05 * HOUR) },
      { kind: 'tool_result', tool_use_id: 'b2', text: 'contents of b', ts: iso(now - 4.02 * HOUR) },
    ],
  );

  // minor: short on both axes, so the noise gate marks it — it must stay out
  // of every aggregate at all/project scope.
  replaceSession(
    { id: 'g-minor', project_id: alpha.id, source: 'claude-code', file_path: '/tmp/g-minor.jsonl',
      started_at: iso(now - 90 * 60000), ended_at: iso(now - 89 * 60000),
      usage: usage({ [MODEL]: { input: 999999, output: 999999, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }) },
    [...turns(now, [-90 * 60000, -89 * 60000])],
  );

  return { alpha, beta };
}

// Rewrites the run's real timestamps into anchor-relative markers so a fixture
// captured today still matches tomorrow: full ISO instants become `+<ms>`
// offsets, local day/hour bucket keys become `D<n>` / `D<n>H<h>` offsets from
// the anchor's local day.
//
// Three outputs are absolute CALENDAR facts that a plain day offset cannot
// carry, so they are normalized on their own terms — without them the fixture
// is only valid on the exact date it was captured:
//   - a WEEKLY bucket key is the week's Monday, whose distance from the anchor
//     depends on the anchor's weekday → `W<n>` weeks from the anchor's Monday;
//   - `dow` (insights' hour-of-day heatmap) is the run day's weekday →
//     `dow+<n>` days from the anchor's weekday;
//   - a bucket `label` is an absolute date string ("Sep 9"), a pure function of
//     the bucket key (shared/bucketLabel.ts, pinned by test/bucket-label.test.mjs)
//     → collapsed to `<label>`.
export function normalizeGolden(value, now) {
  // JSON round-trip first: the fixture is JSON, so `undefined` fields and
  // Dates must drop out of the live result the same way they do on the wire.
  value = JSON.parse(JSON.stringify(value));
  const anchorDay = new Date(now);
  anchorDay.setHours(0, 0, 0, 0);
  const anchorDow = anchorDay.getDay();                 // 0=Sunday, like strftime('%w')
  const anchorMonday = new Date(anchorDay);
  anchorMonday.setDate(anchorMonday.getDate() - ((anchorDow + 6) % 7));
  const dayOffset = (y, m, d) => Math.round((new Date(y, m - 1, d).getTime() - anchorDay.getTime()) / DAY);
  const weekOffset = (y, m, d) => Math.round((new Date(y, m - 1, d).getTime() - anchorMonday.getTime()) / (7 * DAY));

  // Weekly bucket keys are plain `YYYY-MM-DD` strings, indistinguishable from a
  // daily key on their own, so they are rewritten from the result that knows
  // its rollup before the generic walk sees them.
  const markWeeklyBuckets = (v) => {
    if (Array.isArray(v)) { v.forEach(markWeeklyBuckets); return; }
    if (!v || typeof v !== 'object') return;
    if (v.rollup === 'weekly' && Array.isArray(v.buckets)) {
      for (const b of v.buckets) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b?.bucket ?? '');
        if (m) b.bucket = `W${weekOffset(+m[1], +m[2], +m[3])}`;
      }
    }
    for (const val of Object.values(v)) markWeeklyBuckets(val);
  };
  markWeeklyBuckets(value);

  const normString = (s) => {
    let m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/.exec(s);
    if (m) return `+${Date.parse(s) - now}ms`;
    m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(s);
    if (m) return `D${dayOffset(+m[1], +m[2], +m[3])}H${+m[4]}`;
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return `D${dayOffset(+m[1], +m[2], +m[3])}`;
    return s;
  };

  const walk = (v) => {
    if (typeof v === 'string') return normString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const isBucket = typeof v.bucket === 'string';
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        // Row insert-time metadata is wall-clock noise, not engine output.
        if (k === 'created_at' || k === 'imported_at') { out[k] = '<insert-time>'; continue; }
        if (k === 'label' && isBucket) { out[k] = '<label>'; continue; }
        if (k === 'dow' && typeof val === 'number') { out[k] = `dow+${(val - anchorDow + 7) % 7}`; continue; }
        out[normString(k)] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}
