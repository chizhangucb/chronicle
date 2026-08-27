// shared/provider.ts
// Model VENDOR ("provider") mapping — anthropic / openai / google / other — the
// CHI-324 D6 spend stack/pivot axis. This is the model VENDOR, NOT `source`
// (that is the TOOL vendor claude-code/codex/…, already the Sources chart). The
// client twin of server/explore.ts `providerExpr`; the two MUST agree, so the
// prefix rules here mirror that CASE expression exactly (test/provider-of.test.mjs
// pins it). Relative-import value module (never @shared), same B3 rule as
// shared/pricing.ts.

export type Provider = 'anthropic' | 'openai' | 'google' | 'other';

export const PROVIDER_ORDER: Provider[] = ['anthropic', 'openai', 'google', 'other'];

// Prefix-mapped from the model id, mirroring server/explore.ts providerExpr.
export function providerOf(model: string): Provider {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (m.startsWith('gpt') || m.startsWith('codex') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) return 'openai';
  if (m.startsWith('gemini')) return 'google';
  return 'other';
}
