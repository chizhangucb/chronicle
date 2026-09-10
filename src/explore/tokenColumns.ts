import type { PivotGroup, PivotMetric } from './PivotControls.tsx';

// How a group's Explore token magnitude was arrived at, and therefore how the
// Detail table and the card are allowed to present it (CONTEXT.md, "Exact,
// calibrated, partial"):
//
//   'exact'       model/project/source/session: per-model billed cells from
//                 `sessions.usage` (server EXACT_USAGE_GROUPS).
//   'calibrated'  tool/skill/mcp: magnitude attributed by each row's share of
//                 message text length and scaled onto the billed total
//                 (ADR 0006, server CALIBRATED_GROUPS).
//   'partial'     subagent/hour/provider: summed from the per-message token
//                 columns, which carry only ~0.73 of billed usage. Real
//                 numbers, but part of the whole: `sessions.usage` has no
//                 hourly or agent_type split to scale them against, so they
//                 stay per-message by design.
//
// #203: 'partial' used to be presented exactly like 'exact', a bare number in
// the Detail table with no marker anywhere, so part of the bill read as all of
// it. It now carries the `≈` the calibrated groups' card carries. The marker's
// one meaning, on every group that shows it: THIS IS NOT A BILLED TOTAL. Which
// of the two it is, is what the ⓘ beside it answers.
//
// KNOWN GAP, out of this module's reach: group='session' is exact per group
// value, but the server falls back to per-message sums for a session whose
// source never writes `sessions.usage` (codex/cursor/opencode). That is a
// per-ROW property the wire does not report, so a per-GROUP table cannot mark
// it. Marking every session row would misreport the claude-code majority.
//
// Kept as a standalone pure module so it is unit-testable without importing the
// React/JSX-bearing ExploreTab.
type TokenBasis = 'exact' | 'calibrated' | 'partial';

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

/** The definition id the `≈` marker's ⓘ opens, per kind of figure. */
const MARKER_DEF: Record<Exclude<TokenBasis, 'exact'>, string> = {
  calibrated: 'spend.token-attribution',
  partial: 'explore.partial-tokens',
};

/**
 * The Detail table's Tokens cell text, given the row's tokens and the
 * formatter the table uses for them.
 *
 * Calibrated groups suppress to `—` (EXP-02): restating a text-share figure
 * next to real Requests/Sessions claims a precision the method lacks, and the
 * card already says `≈`. Partial groups show their real number, marked. A zero
 * row is shown bare under every basis: there is nothing there to be part of.
 *
 * SCOPE: the TOKENS column only. `$/session` is spend-derived (rowSpend /
 * sessions), not token-derived, so it shows for every group; gating it here
 * would contradict the Spend value on the same row.
 */
export function detailTokensCell(
  group: PivotGroup,
  tokens: number,
  format: (n: number) => string,
): string {
  const basis = TOKEN_BASIS[group];
  if (basis === 'calibrated') return '—';
  const formatted = format(tokens);
  return basis === 'partial' && tokens > 0 ? `≈${formatted}` : formatted;
}

/**
 * Whether the ranked-bars/chart card carries the `≈` marker, and which
 * definition its ⓘ opens.
 *
 * `serverCalibrated` is `ExploreWireResult.calibrated`, which the server sets
 * for its own CALIBRATED_GROUPS and only when the displayed metric reads token
 * magnitude. Honored verbatim, so the wire stays the authority on calibration.
 * The partial groups are added here on that same metric rule: under
 * Requests/Sessions/Errors the card shows counts, not tokens, and a marker
 * there would mark a number the shortfall does not touch.
 */
export function cardTokenMarker(
  group: PivotGroup,
  metric: PivotMetric,
  serverCalibrated: boolean,
): { show: boolean; def: string } {
  if (serverCalibrated) return { show: true, def: MARKER_DEF.calibrated };
  const readsTokens = metric === 'tokens' || metric === 'spend';
  return { show: readsTokens && TOKEN_BASIS[group] === 'partial', def: MARKER_DEF.partial };
}
