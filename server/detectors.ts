// server/detectors.ts — the Efficiency DETECTOR counts, windowed.
// Ships COUNTS (not graded words or dollars): the client computes the four
// detector rates and grades them with the shared thresholds/state-words so a
// number and the word next to it can never disagree. Cache-hit and error-rate
// are already derivable client-side from /api/insights; jumbo + long-context
// need this per-message pass over the messages table.
import { db } from './db.ts';
import { queryContext, whereOf, type Range, type Scope } from './scope.ts';
import { DEFAULT_SPEND_THRESHOLDS } from '../shared/spend/thresholds.ts';

// Declared in shared/results.ts (#307): the client derives and grades the rates
// from these counts, so both sides read one contract.
import type { DetectorCounts } from '../shared/results.ts';

interface CountRow {
  assistantRows: number | null;
  jumboRows: number | null;
  longContextRows: number | null;
  cacheReadTokens: number | null;
  inputTokens: number | null;
}

export function computeDetectors(scope: Scope, range: Range): DetectorCounts {
  const { jumboOutputTokens, longContextTokens } = DEFAULT_SPEND_THRESHOLDS.detectors;
  const q = queryContext(scope, range);
  // Message range (timestamp), scope clause and minor gate all come from the
  // query context — see server/scope.ts.
  const w = whereOf("AND m.kind = 'assistant' AND m.model IS NOT NULL", q.where, q.messages());
  const r = db.prepare(
    `SELECT
       COUNT(*) AS assistantRows,
       SUM(CASE WHEN COALESCE(m.output_tokens,0) > ? THEN 1 ELSE 0 END) AS jumboRows,
       SUM(CASE WHEN (COALESCE(m.input_tokens,0) + COALESCE(m.cache_read_tokens,0)) > ? THEN 1 ELSE 0 END) AS longContextRows,
       SUM(COALESCE(m.cache_read_tokens,0)) AS cacheReadTokens,
       SUM(COALESCE(m.input_tokens,0)) AS inputTokens
     FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE ${w.sql}`,
  ).get(jumboOutputTokens, longContextTokens, ...w.params) as unknown as CountRow;
  return {
    assistantRows: r.assistantRows ?? 0,
    jumboRows: r.jumboRows ?? 0,
    longContextRows: r.longContextRows ?? 0,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    inputTokens: r.inputTokens ?? 0,
  };
}
