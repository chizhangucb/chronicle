/**
 * /ask (CHI-351) cost-surface builder, split out of scripts/ask-db-mcp.ts so it
 * is importable by node --test (that script opens the db + reads stdin at import
 * time, so it can't be imported). Given a READ-ONLY db handle it builds, in the
 * TEMP schema (writable even on a read-only main db — chronicle.db is untouched):
 *
 *   pricing(model, input, output, cw5m, cw1h, cache_read)   one row per concrete
 *       model, resolved through the single price source for the run's cost basis.
 *   session_model_cost   deduped per-(session,model) $ from sessions.usage —
 *       RECONCILES with the Insights dashboards (same source).
 *   message_cost         per-message $ (CHI-286 already nulled replayed rows) —
 *       for subagent / tool / skill / by-day cuts.
 *
 * Each CREATE is independent + guarded so an odd SQLite build (no json1) degrades
 * to "base tables only" rather than failing the whole run.
 */
import type { DatabaseSync } from 'node:sqlite';
import { pricingFor, type CostMode } from '../shared/pricing.ts';

export function distinctModels(d: DatabaseSync): string[] {
  const set = new Set<string>();
  const add = (sql: string): void => {
    try {
      for (const r of d.prepare(sql).all() as Array<{ m: unknown }>) if (r.m) set.add(String(r.m));
    } catch { /* json1 or column may be absent; degrade */ }
  };
  add(`SELECT DISTINCT je.key AS m FROM sessions, json_each(usage) je WHERE usage IS NOT NULL`);
  add(`SELECT DISTINCT model AS m FROM messages WHERE model IS NOT NULL`);
  return [...set];
}

export interface BuildCostSurfaceResult { pricingRows: number; sessionView: boolean; messageView: boolean; }

export function buildCostSurface(
  d: DatabaseSync,
  costMode: CostMode,
  day: string,
  onWarn: (m: string) => void = () => {},
): BuildCostSurfaceResult {
  d.exec(`CREATE TEMP TABLE IF NOT EXISTS pricing(
    model TEXT PRIMARY KEY, input REAL, output REAL, cw5m REAL, cw1h REAL, cache_read REAL)`);
  const ins = d.prepare(`INSERT OR IGNORE INTO pricing VALUES (?,?,?,?,?,?)`);
  let pricingRows = 0;
  for (const m of distinctModels(d)) {
    const p = pricingFor(m, day, costMode);
    if (p) { ins.run(m, p.input, p.output, p.cw5m, p.cw1h, p.cacheRead); pricingRows++; }
  }
  let sessionView = false, messageView = false;
  // Deduped per-(session,model) from sessions.usage. Legacy `cacheWrite`
  // (pre-TTL-split) folds into the 5m bucket, matching src/models.ts.
  try {
    d.exec(`CREATE TEMP VIEW session_model_cost AS
      SELECT s.id AS session_id, p.path AS project_path, s.source,
             s.started_at, s.ended_at, date(COALESCE(s.started_at, s.ended_at)) AS day,
             s.usage_source, je.key AS model,
             COALESCE(CAST(json_extract(je.value,'$.input') AS INTEGER),0) AS input_tokens,
             COALESCE(CAST(json_extract(je.value,'$.output') AS INTEGER),0) AS output_tokens,
             COALESCE(CAST(json_extract(je.value,'$.cacheRead') AS INTEGER),0) AS cache_read_tokens,
             COALESCE(CAST(json_extract(je.value,'$.cacheWrite5m') AS INTEGER),
                      CAST(json_extract(je.value,'$.cacheWrite') AS INTEGER),0) AS cache_w5m_tokens,
             COALESCE(CAST(json_extract(je.value,'$.cacheWrite1h') AS INTEGER),0) AS cache_w1h_tokens,
             ROUND((
               COALESCE(CAST(json_extract(je.value,'$.input') AS INTEGER),0)*pr.input
             + COALESCE(CAST(json_extract(je.value,'$.output') AS INTEGER),0)*pr.output
             + COALESCE(CAST(json_extract(je.value,'$.cacheRead') AS INTEGER),0)*pr.cache_read
             + COALESCE(CAST(json_extract(je.value,'$.cacheWrite5m') AS INTEGER),
                        CAST(json_extract(je.value,'$.cacheWrite') AS INTEGER),0)*pr.cw5m
             + COALESCE(CAST(json_extract(je.value,'$.cacheWrite1h') AS INTEGER),0)*pr.cw1h
             )/1e6, 6) AS cost_usd
      FROM sessions s JOIN projects p ON p.id = s.project_id, json_each(s.usage) je
      LEFT JOIN pricing pr ON pr.model = je.key
      WHERE s.usage IS NOT NULL`);
    sessionView = true;
  } catch (err) { onWarn(`session_model_cost unavailable: ${(err as Error).message}`); }
  // Per-message, deduped (CHI-286 nulled replayed token rows; all COALESCEd).
  try {
    d.exec(`CREATE TEMP VIEW message_cost AS
      SELECT m.session_id, m.seq, m.ts, date(m.ts) AS day, m.model, m.kind, m.tool_name,
             CASE WHEN m.tool_name LIKE 'mcp__%'
                  THEN substr(m.tool_name, 6, instr(substr(m.tool_name, 6), '__') - 1) END AS mcp_server,
             m.skill, m.is_sidechain, m.agent_type, m.agent_id, m.workflow_id,
             p.path AS project_path, s.source,
             COALESCE(m.input_tokens,0) AS input_tokens, COALESCE(m.output_tokens,0) AS output_tokens,
             COALESCE(m.cache_read_tokens,0) AS cache_read_tokens,
             COALESCE(m.cache_w5m_tokens,0) AS cache_w5m_tokens,
             COALESCE(m.cache_w1h_tokens,0) AS cache_w1h_tokens,
             ROUND((
               COALESCE(m.input_tokens,0)*pr.input + COALESCE(m.output_tokens,0)*pr.output
             + COALESCE(m.cache_read_tokens,0)*pr.cache_read
             + COALESCE(m.cache_w5m_tokens,0)*pr.cw5m + COALESCE(m.cache_w1h_tokens,0)*pr.cw1h
             )/1e6, 6) AS cost_usd
      FROM messages m JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id
      LEFT JOIN pricing pr ON pr.model = m.model`);
    messageView = true;
  } catch (err) { onWarn(`message_cost unavailable: ${(err as Error).message}`); }
  return { pricingRows, sessionView, messageView };
}
