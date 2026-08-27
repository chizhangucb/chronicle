// server/detectors.ts (CHI-324 2e) — the Efficiency DETECTOR counts, windowed.
// Ships COUNTS (not graded words or dollars): the client computes the four
// detector rates and grades them with the shared thresholds/state-words so a
// number and the word next to it can never disagree. Cache-hit and error-rate
// are already derivable client-side from /api/insights; jumbo + long-context
// need this per-message pass over the messages table.
import { db } from './db.ts';
import { DEFAULT_SPEND_THRESHOLDS } from '../shared/spend/thresholds.ts';

const DAY = 86400000;

export interface DetectorCounts {
  /** assistant messages carrying a model in the window — the denominator for
   * the jumbo and long-context shares. */
  assistantRows: number;
  /** assistant messages whose output exceeded the jumbo threshold. */
  jumboRows: number;
  /** assistant messages whose fed-in context (input + cache-read) exceeded the
   * long-context threshold. */
  longContextRows: number;
  /** token sums for the cache-hit rate = cacheRead / (cacheRead + input). */
  cacheReadTokens: number;
  inputTokens: number;
}

interface CountRow {
  assistantRows: number | null;
  jumboRows: number | null;
  longContextRows: number | null;
  cacheReadTokens: number | null;
  inputTokens: number | null;
}

export function computeDetectors(days: number | null): DetectorCounts {
  const { jumboOutputTokens, longContextTokens } = DEFAULT_SPEND_THRESHOLDS.detectors;
  const cutoff = days != null ? new Date(Date.now() - days * DAY).toISOString() : null;
  const gate = cutoff ? 'AND m.ts >= ?' : '';
  const args: (string | number)[] = [jumboOutputTokens, longContextTokens];
  if (cutoff) args.push(cutoff);
  const r = db.prepare(
    `SELECT
       COUNT(*) AS assistantRows,
       SUM(CASE WHEN COALESCE(m.output_tokens,0) > ? THEN 1 ELSE 0 END) AS jumboRows,
       SUM(CASE WHEN (COALESCE(m.input_tokens,0) + COALESCE(m.cache_read_tokens,0)) > ? THEN 1 ELSE 0 END) AS longContextRows,
       SUM(COALESCE(m.cache_read_tokens,0)) AS cacheReadTokens,
       SUM(COALESCE(m.input_tokens,0)) AS inputTokens
     FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE m.kind = 'assistant' AND m.model IS NOT NULL AND COALESCE(s.minor,0) = 0 ${gate}`,
  ).get(...args) as unknown as CountRow;
  return {
    assistantRows: r.assistantRows ?? 0,
    jumboRows: r.jumboRows ?? 0,
    longContextRows: r.longContextRows ?? 0,
    cacheReadTokens: r.cacheReadTokens ?? 0,
    inputTokens: r.inputTokens ?? 0,
  };
}
