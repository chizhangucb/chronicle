import type { PivotGroup } from './PivotControls.tsx';

// Whether the Detail table should show a concrete Tokens value for a group, or
// suppress it to `—` because the number is a calibrated estimate.
//
// Two kinds of groups DO show a real number:
//   - model/project/source: authoritative per-model billed cells (server
//     EXACT_USAGE_GROUPS, sourced from sessions.usage).
//   - subagent/hour: summed from per-message token columns. Not billed-exact,
//     but the app already treats these as real elsewhere (CLAUDE.md: "Content's
//     subagent token share is EXACT from per-message sidechain columns") and
//     the Explore card/ranked-bar show the concrete number UNMARKED for these
//     groups (server sets result.calibrated ONLY for tool/skill). So the Detail
//     table must match — showing `—` here would contradict the card/bar.
//
// Only tool/skill are TRULY calibrated: token magnitude is estimated from
// message-text length (server CALIBRATED_GROUPS) and the card carries the `≈`
// badge. For those the Detail Tokens column suppresses to `—`, consistent with
// the card's "approximate — see ≈" marking, rather than restating an estimate
// as an exact figure next to real Requests/Sessions.
//
// SCOPE: this gates the TOKENS column ONLY. `$/session` is SPEND-derived
// (rowSpend / sessions), NOT token-derived, so it is shown for EVERY group —
// gating it here would contradict the Spend value shown in the same row.
//
// Kept as a standalone pure module so it is unit-testable without importing the
// React/JSX-bearing ExploreTab.
const CALIBRATED_GROUPS: ReadonlySet<PivotGroup> = new Set<PivotGroup>([
  'tool', 'skill',
]);

export function groupShowsTokenColumn(group: PivotGroup): boolean {
  return !CALIBRATED_GROUPS.has(group);
}
