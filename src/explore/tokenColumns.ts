import type { PivotGroup, PivotMetric } from './PivotControls.tsx';

// How a group's Explore token magnitude was arrived at, and therefore how the
// Detail table and the card are allowed to present it.
//
//   'exact'       model/project/source/session — authoritative per-model billed
//                 cells from `sessions.usage` (server EXACT_USAGE_GROUPS).
//   'calibrated'  tool/skill/mcp — magnitude estimated from each row's share of
//                 message text length, scaled onto the billed total (ADR 0006,
//                 server CALIBRATED_GROUPS).
//   'partial'     subagent/hour/provider — summed from the per-message token
//                 columns, which carry only ~0.73 of billed usage (≈27% is
//                 never stored per row, and ~70% of what is stored sits on
//                 tool_use rows). Real numbers, but a known undercount; there
//                 is no hour/agent_type split in `sessions.usage` to reconcile
//                 them against, so they stay per-message by design.
//
// #203: 'partial' used to be presented exactly like 'exact' — a bare number in
// the Detail table with no marker anywhere — so an undercount read as billed.
// It now carries the same `≈` the calibrated groups' card carries. The badge's
// one meaning across every group that shows it: THIS IS NOT A BILLED TOTAL.
// Which kind of approximation it is is what the ⓘ beside it answers.
//
// Kept as a standalone pure module so it is unit-testable without importing the
// React/JSX-bearing ExploreTab.
export type TokenBasis = 'exact' | 'calibrated' | 'partial';

const TOKEN_BASIS: Readonly<Record<PivotGroup, TokenBasis>> = {
  model: 'exact',
  project: 'exact',
  source: 'exact',
  session: 'exact',
  tool: 'calibrated',
  skill: 'calibrated',
  mcp: 'calibrated',
  subagent: 'partial',
  hour: 'partial',
  provider: 'partial',
};

export function groupTokenBasis(group: PivotGroup): TokenBasis {
  return TOKEN_BASIS[group];
}

// Whether the Detail table shows a concrete Tokens value for a group at all.
// Calibrated groups suppress to `—` (EXP-02): restating a text-share estimate
// as a figure next to real Requests/Sessions overstates what the method knows,
// and the card already says `≈`.
//
// SCOPE: this gates the TOKENS column ONLY. `$/session` is SPEND-derived
// (rowSpend / sessions), NOT token-derived, so it is shown for EVERY group —
// gating it here would contradict the Spend value shown in the same row.
export function groupShowsTokenColumn(group: PivotGroup): boolean {
  return groupTokenBasis(group) !== 'calibrated';
}

/** The Detail table's Tokens cell text, given the already-formatted number. */
export function detailTokensCell(group: PivotGroup, formatted: string): string {
  switch (groupTokenBasis(group)) {
    case 'calibrated': return '—';
    case 'partial': return `≈${formatted}`;
    case 'exact': return formatted;
  }
}

/** The definition id the `≈` badge's ⓘ opens, per kind of approximation. */
const APPROX_DEF: Record<Exclude<TokenBasis, 'exact'>, string> = {
  calibrated: 'spend.token-attribution',
  partial: 'explore.approximate-tokens',
};

/**
 * Whether the ranked-bars/chart card carries the `≈` badge, and which
 * definition its ⓘ opens.
 *
 * `serverCalibrated` is `ExploreWireResult.calibrated`, which the server sets
 * for its own CALIBRATED_GROUPS and only when the displayed metric reads token
 * magnitude — honored verbatim, so the wire stays the authority on calibration.
 * The per-message ('partial') groups are added here on that same metric rule:
 * under Requests/Sessions/Errors the card is showing counts, not tokens, and a
 * badge there would mark a number the approximation does not touch.
 */
export function cardApproxBadge(
  group: PivotGroup,
  metric: PivotMetric,
  serverCalibrated: boolean,
): { show: boolean; def: string } {
  if (serverCalibrated) return { show: true, def: APPROX_DEF.calibrated };
  const readsTokens = metric === 'tokens' || metric === 'spend';
  const show = readsTokens && groupTokenBasis(group) === 'partial';
  return { show, def: APPROX_DEF.partial };
}
