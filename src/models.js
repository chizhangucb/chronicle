// Static per-model context-window table (tokens), cached from the Anthropic
// model catalog (platform.claude.com, 2026-06) plus common non-Claude models
// Chronicle can import. Pure lookup — never fetched at runtime, preserving the
// offline guarantee. Ordered: more specific prefixes must come first.
const CONTEXT_WINDOWS = [
  // Claude — 1M-context generation
  ['claude-fable-5', 1_000_000],
  ['claude-mythos', 1_000_000],
  ['claude-opus-4-8', 1_000_000],
  ['claude-opus-4-7', 1_000_000],
  ['claude-opus-4-6', 1_000_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-sonnet-4-6', 1_000_000],
  // Claude — 200K models (Haiku 4.5/3.x, Opus 4.5/4.1/4.0/3, Sonnet 4.5/4.0/3.x)
  ['claude-haiku', 200_000],
  ['claude-opus', 200_000],
  ['claude-sonnet', 200_000],
  ['claude', 200_000],
  // Non-Claude sources (Codex, Gemini CLI, Copilot)
  ['gpt-5', 400_000],
  ['gpt-4', 128_000],
  ['o3', 200_000],
  ['o4', 200_000],
  ['gemini', 1_000_000],
];

// Longest-prefix-style lookup by substring; returns tokens or null if unknown.
export function contextWindowFor(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const [prefix, window] of CONTEXT_WINDOWS) {
    if (m.includes(prefix)) return window;
  }
  return null;
}
