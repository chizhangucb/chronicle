import type { PivotGroup } from './PivotControls.tsx';

// Which Explore groups carry AUTHORITATIVE per-model token cells.
//
// `server/explore.ts` only sources tokensByModel from the billed
// `sessions.usage` per-model cells for its EXACT_USAGE_GROUPS
// (model/project/source). For every other group — tool/skill (token magnitude
// is CALIBRATED post-hoc from message-text length) and subagent/hour (summed
// from per-message columns that undercount billed usage) — the per-model cells
// are either synthetic or approximate, NOT an authoritative per-model billed
// breakdown. Presenting them in the Detail table's exact-looking `Tokens` /
// `$/session` columns (no ≈, next to real Requests/Sessions) reads as a precise
// figure it isn't, so those cells render `—` instead (EXP-02). The card's own
// metric already shows the calibrated tokens/spend with an ≈ badge for those
// groups; the Detail table just doesn't restate them as if exact.
//
// Kept as a standalone pure module so it is unit-testable without importing the
// React/JSX-bearing ExploreTab.
const GROUPS_WITH_PER_MODEL_TOKENS: ReadonlySet<PivotGroup> = new Set<PivotGroup>([
  'model', 'project', 'source',
]);

export function groupHasPerModelTokens(group: PivotGroup): boolean {
  return GROUPS_WITH_PER_MODEL_TOKENS.has(group);
}
