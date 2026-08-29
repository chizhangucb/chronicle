// Vendor-varied synthetic sessions for the seeded release walk (CHI-324 2i).
//
// The real DB (and the demo hub slices) are nearly all `claude-*`, so the Spend
// tab's [project|provider] toggle, the median-session dash, and the routing
// table all collapse to ~one vendor on a normal walk. This fixture set spans
// four model VENDORS (shared/provider.ts providerOf keys off the model-id
// prefix) across three projects, with varied token magnitudes, so a walk seeded
// with it shows real variety:
//
//   claude-opus-4-8 / claude-sonnet-5  -> anthropic (subscription-covered: list $ > 0, billed ~$0)
//   gpt-5                              -> openai    (metered: real $ > 0 in both modes)
//   gemini-2.5-pro                     -> google    (metered)
//   mistral-large-2                    -> other     (OFF-ROSTER + unpriced: $0, shows in routing/tokens)
//
// It is fed ONLY into a throwaway temp DB by scripts/walk-seed.mjs — never the
// operator's real ~/.chronicle DB (the confidentiality/real-data floor). The
// same list backs the regression pin (test/walk-vendor-variety.test.mjs), so a
// regression back to one vendor fails the build.

// The distinct model vendors this fixture set must exercise (the pin asserts
// providerOf maps the seeded models onto at least these).
export const WALK_REQUIRED_PROVIDERS = ['anthropic', 'openai', 'google', 'other'];

// Three synthetic project cwds, so the [project] axis also shows spread.
const P_CHRON = '/tmp/walk-chronicle';
const P_API = '/tmp/walk-api-gateway';
const P_WEB = '/tmp/walk-webapp';

// One assistant-message usage bag per magnitude tier (applied to every
// assistant turn in a session; 8 turns per session).
const usage = (input, output, cacheRead = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead });

// The seed specs, vendor-varied. `daysAgo` is resolved to an absolute ISO date
// at seed time (so the sessions always land inside the recent windows). Every
// session runs 8 turns (16 messages) so it clears the noise gate into the main
// ledger and shows up in spend.
// One session per vendor lands on `daysAgo: 0` (today), so even the default
// Today window shows all four vendors under the [provider] toggle; the rest are
// spread across the week for the spend-over-time series + a real median spread.
const SPECS = [
  { sessionId: 'walk-opus-1', model: 'claude-opus-4-8', cwd: P_CHRON, daysAgo: 0, promptText: 'Walk fixture: refactor the insights engine.', usage: usage(4200, 1300, 800) },
  { sessionId: 'walk-gpt-1', model: 'gpt-5', cwd: P_API, daysAgo: 0, promptText: 'Walk fixture: implement the OpenAI adapter.', usage: usage(3100, 1500) },
  { sessionId: 'walk-gemini-1', model: 'gemini-2.5-pro', cwd: P_WEB, daysAgo: 0, promptText: 'Walk fixture: generate the marketing copy variants.', usage: usage(3300, 1000) },
  { sessionId: 'walk-mistral-1', model: 'mistral-large-2', cwd: P_WEB, daysAgo: 0, promptText: 'Walk fixture: off-roster model spike (evaluation).', usage: usage(2400, 700) },
  { sessionId: 'walk-opus-2', model: 'claude-opus-4-8', cwd: P_WEB, daysAgo: 2, promptText: 'Walk fixture: redesign the spend tab layout.', usage: usage(3800, 1100, 600) },
  { sessionId: 'walk-sonnet-1', model: 'claude-sonnet-5', cwd: P_CHRON, daysAgo: 1, promptText: 'Walk fixture: wire the routing table.', usage: usage(2600, 900) },
  { sessionId: 'walk-gpt-2', model: 'gpt-5', cwd: P_API, daysAgo: 3, promptText: 'Walk fixture: add retry + backoff to the gateway.', usage: usage(2800, 1200) },
  { sessionId: 'walk-gemini-2', model: 'gemini-2.5-pro', cwd: P_API, daysAgo: 4, promptText: 'Walk fixture: summarize the incident timeline.', usage: usage(2900, 850) },
];

// The seeded model set, for the regression pin.
export const WALK_VENDOR_MODELS = [...new Set(SPECS.map((s) => s.model))];

/** Resolve the seed specs to absolute dates relative to `nowMs`. Each session
 * starts at ~11:00 local on its target day and runs 8 turns; `daysAgo: 0` is
 * pinned a couple hours back so it is unambiguously "today" without risking the
 * future. Returns the exact opts writeMiniSession takes. */
export function walkVendorSessions(nowMs) {
  return SPECS.map((s) => {
    const start = s.daysAgo === 0
      ? new Date(nowMs - 3 * 3600 * 1000)               // ~3h ago -> today
      : new Date(nowMs - s.daysAgo * 24 * 3600 * 1000); // N days ago
    return {
      sessionId: s.sessionId,
      model: s.model,
      cwd: s.cwd,
      dateISO: start.toISOString(),
      turns: 8,
      promptText: s.promptText,
      usage: s.usage,
    };
  });
}
