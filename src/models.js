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

// Per-model list price in USD per 1M tokens, from the Anthropic pricing table
// (platform.claude.com). 5m and 1h cache writes are priced separately — Claude
// Code's /usage bills each tier, and a session can be entirely 1h-cached.
// Used to reproduce /usage cost from raw token counts (logs carry tokens, not $).
// Ordered: more specific prefixes first.
const P = (input, output, cw5m, cw1h, cacheRead) => ({ input, output, cw5m, cw1h, cacheRead });
const PRICING = [
  ['claude-fable-5', P(10, 50, 12.5, 20, 1)],
  ['claude-mythos', P(10, 50, 12.5, 20, 1)],
  ['claude-opus-4-1', P(15, 75, 18.75, 30, 1.5)], // Opus 4.1 (deprecated) — old tier
  ['claude-opus-4-0', P(15, 75, 18.75, 30, 1.5)], // Opus 4.0 (retired) — old tier
  ['claude-opus', P(5, 25, 6.25, 10, 0.5)],        // Opus 4.8/4.7/4.6/4.5 + default
  ['claude-sonnet', P(3, 15, 3.75, 6, 0.3)],        // Sonnet 5 (std)/4.6/4.5/4
  ['claude-haiku', P(1, 5, 1.25, 2, 0.1)],
  ['claude', P(5, 25, 6.25, 10, 0.5)],
  // Best-effort for non-Claude sources Chronicle can import (no cache tiers).
  ['gpt-5', P(1.25, 10, 1.25, 1.25, 0.125)],
  ['gpt-4', P(2.5, 10, 2.5, 2.5, 1.25)],
  ['gemini', P(1.25, 10, 1.25, 1.25, 0.3125)],
];

export function pricingFor(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const [prefix, price] of PRICING) if (m.includes(prefix)) return price;
  return null;
}

// Per-category cost in USD for one model's aggregated token usage; null if the
// model is unpriced. Handles both the new usage shape ({cacheWrite5m, cacheWrite1h})
// and the legacy one ({cacheWrite}, treated as 5m). Static lookup — no fetch.
export function costBreakdownOf(model, u) {
  const p = pricingFor(model);
  if (!p || !u) return null;
  const cw5 = u.cacheWrite5m ?? u.cacheWrite ?? 0;
  const cw1 = u.cacheWrite1h ?? 0;
  return {
    input: ((u.input || 0) * p.input) / 1e6,
    output: ((u.output || 0) * p.output) / 1e6,
    cacheWrite: (cw5 * p.cw5m + cw1 * p.cw1h) / 1e6,
    cacheRead: ((u.cacheRead || 0) * p.cacheRead) / 1e6,
  };
}

// Combined cache-write token count across both tiers (for display).
export function cacheWriteTokens(u) {
  return (u.cacheWrite5m ?? 0) + (u.cacheWrite1h ?? 0) || (u.cacheWrite ?? 0);
}

// Total cost in USD for one model's aggregated token usage; null if unpriced.
export function costOf(model, u) {
  const b = costBreakdownOf(model, u);
  return b ? b.input + b.output + b.cacheWrite + b.cacheRead : null;
}
