// Shared per-model context-window table (tokens). Framework-free, like
// shared/types.ts — these are model CONSTANTS (max context size), not prices.
// Prices stay client-only in src/models.ts (CLAUDE.md's money-policy rule:
// "the price table lives ONLY in src/models.ts, NEVER duplicated server-side").
// Windows are different: both the client (session Overview's context-used
// gauge) and the server (Content tab's highContextRel characteristic /
// context-pressure callout) need to compare a session's context_tokens
// against its model's window, so this table is mirrored into `shared/` once
// instead of hand-copy-pasted into both src/models.ts and server/content.ts
// (that duplication used to carry an explicit "keep these two in sync"
// comment — this file removes the need for it). Both sides import it via a
// relative path (server: `../shared/contextWindows.ts`) or the `@shared`
// alias (client: `@shared/contextWindows.ts`), matching shared/types.ts's
// existing import convention.
//
// Cached from the Anthropic model catalog (platform.claude.com, 2026-06) plus
// common non-Claude models Chronicle can import. Pure lookup — never fetched
// at runtime, preserving the offline guarantee. Ordered: more specific
// prefixes must come first.
export const CONTEXT_WINDOWS: [string, number][] = [
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
export function contextWindowFor(model: string | null | undefined): number | null {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const [prefix, window] of CONTEXT_WINDOWS) {
    if (m.includes(prefix)) return window;
  }
  return null;
}
