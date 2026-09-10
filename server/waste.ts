// server/waste.ts — the Efficiency WASTE SIGNALS: cache churn, right-sizing
// and rereads. The heavy per-message / per-tool-call scan runs here and ships TOKEN
// CELLS + counts; the client prices the premium / savings / wasted-$ via the
// shared price table (never server dollar math). Windowed by message ts; minor
// sessions excluded, matching server/detectors.ts.
import { db } from './db.ts';
import { DEFAULT_SPEND_THRESHOLDS } from '../shared/spend/thresholds.ts';

const DAY = 86400000;

export interface ModelCacheCells { cw5m: number; cw1h: number }
export interface ChurnSession {
  session: string; project: string;
  writeTokens: number; readTokens: number;
  byModel: Record<string, ModelCacheCells>; // for the premium-$ pricing
}
export interface RightSizingModel {
  model: string; messages: number;
  input: number; output: number; cacheRead: number; cw5m: number; cw1h: number;
}
export interface RereadFile { path: string; rereads: number; sessions: number }
export interface WasteResult {
  cacheChurn: { sessionsFlagged: number; top: ChurnSession[] };
  rightSizing: { candidates: RightSizingModel[] }; // small-turn msgs; client filters premium + reprices
  rereads: { rereadCalls: number; sessionsAffected: number; estWastedTokens: number; topFiles: RereadFile[] };
}

interface ChurnRow { session_id: string; project: string; writeTok: number; readTok: number }
interface ModelCacheRow { session_id: string; model: string; cw5m: number; cw1h: number }
interface RsRow { model: string; messages: number; input: number; output: number; cacheRead: number; cw5m: number; cw1h: number }
interface ReadRow { session_id: string; seq: number; tool_input: string | null; result_chars: number | null }

function gate(days: number | null): { clause: string; args: (string | number)[] } {
  if (days == null) return { clause: '', args: [] };
  return { clause: 'AND m.ts >= ?', args: [new Date(Date.now() - days * DAY).toISOString()] };
}

// ---- Cache churn: sessions that wrote more cache than they read back ----
function cacheChurn(days: number | null): WasteResult['cacheChurn'] {
  const g = gate(days);
  const churn = db.prepare(
    `SELECT m.session_id, p.name AS project,
            SUM(COALESCE(m.cache_w5m_tokens,0) + COALESCE(m.cache_w1h_tokens,0)) AS writeTok,
            SUM(COALESCE(m.cache_read_tokens,0)) AS readTok
     FROM messages m JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id
     WHERE m.kind = 'assistant' AND m.model IS NOT NULL AND COALESCE(s.minor,0) = 0 ${g.clause}
     GROUP BY m.session_id
     HAVING writeTok > readTok AND writeTok > 0
     ORDER BY writeTok DESC LIMIT 20`,
  ).all(...g.args) as unknown as ChurnRow[];
  const sessionsFlagged = (db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT m.session_id,
              SUM(COALESCE(m.cache_w5m_tokens,0)+COALESCE(m.cache_w1h_tokens,0)) AS w,
              SUM(COALESCE(m.cache_read_tokens,0)) AS r
       FROM messages m JOIN sessions s ON s.id=m.session_id
       WHERE m.kind='assistant' AND m.model IS NOT NULL AND COALESCE(s.minor,0)=0 ${g.clause}
       GROUP BY m.session_id HAVING w > r AND w > 0)`,
  ).get(...g.args) as unknown as { n: number }).n;

  const top: ChurnSession[] = churn.map((c) => {
    const cells = db.prepare(
      `SELECT m.model, SUM(COALESCE(m.cache_w5m_tokens,0)) AS cw5m, SUM(COALESCE(m.cache_w1h_tokens,0)) AS cw1h
       FROM messages m WHERE m.session_id = ? AND m.kind='assistant' AND m.model IS NOT NULL
       GROUP BY m.model`,
    ).all(c.session_id) as unknown as ModelCacheRow[];
    const byModel: Record<string, ModelCacheCells> = {};
    for (const r of cells) byModel[r.model] = { cw5m: r.cw5m, cw1h: r.cw1h };
    return { session: c.session_id, project: c.project, writeTokens: c.writeTok, readTokens: c.readTok, byModel };
  });
  return { sessionsFlagged, top };
}

// ---- Model right-sizing: small premium-model turns that look Sonnet-sized ----
// Server ships small-turn assistant messages grouped by model (token cells +
// count); the client filters to premium models (input rate >= threshold) and
// reprices at Sonnet. The premium/small filter that needs pricing lives client-
// side; only the token-size filter (output/context) is applied here.
function rightSizing(days: number | null): WasteResult['rightSizing'] {
  const { rightsizingMaxOutputTokens: maxOut, rightsizingMaxContextTokens: maxCtx } = DEFAULT_SPEND_THRESHOLDS.detectors;
  const g = gate(days);
  const rows = db.prepare(
    `SELECT m.model, COUNT(*) AS messages,
            SUM(COALESCE(m.input_tokens,0)) AS input, SUM(COALESCE(m.output_tokens,0)) AS output,
            SUM(COALESCE(m.cache_read_tokens,0)) AS cacheRead,
            SUM(COALESCE(m.cache_w5m_tokens,0)) AS cw5m, SUM(COALESCE(m.cache_w1h_tokens,0)) AS cw1h
     FROM messages m JOIN sessions s ON s.id = m.session_id
     WHERE m.kind='assistant' AND m.model IS NOT NULL AND COALESCE(s.minor,0)=0 ${g.clause}
       AND COALESCE(m.output_tokens,0) < ?
       AND (COALESCE(m.input_tokens,0) + COALESCE(m.cache_read_tokens,0)) < ?
     GROUP BY m.model`,
  ).all(...g.args, maxOut, maxCtx) as unknown as RsRow[];
  return { candidates: rows.map((r) => ({ model: r.model, messages: r.messages, input: r.input, output: r.output, cacheRead: r.cacheRead, cw5m: r.cw5m, cw1h: r.cw1h })) };
}

// ---- Repeated file re-reads: a Read of a path already read this session ----
function rereads(days: number | null): WasteResult['rereads'] {
  const g = gate(days);
  // Read tool_use rows + their matching tool_result char count, in session/seq order.
  const rows = db.prepare(
    `SELECT m.session_id, m.seq, m.tool_input, LENGTH(r.text) AS result_chars
     FROM messages m JOIN sessions s ON s.id = m.session_id
     LEFT JOIN messages r ON r.session_id = m.session_id AND r.tool_use_id = m.tool_use_id AND r.kind = 'tool_result'
     WHERE m.kind='tool_use' AND m.tool_name='Read' AND COALESCE(s.minor,0)=0 ${g.clause}
     ORDER BY m.session_id, m.seq`,
  ).all(...g.args) as unknown as ReadRow[];

  const files = new Map<string, { rereads: number; sessions: Set<string> }>();
  const seenBySession = new Map<string, Set<string>>();
  const affected = new Set<string>();
  let rereadCalls = 0; let wastedChars = 0;
  for (const r of rows) {
    let path: string | null = null;
    try { path = r.tool_input ? (JSON.parse(r.tool_input) as { file_path?: string }).file_path ?? null : null; } catch { path = null; }
    if (!path) continue;
    let seen = seenBySession.get(r.session_id);
    if (!seen) { seen = new Set(); seenBySession.set(r.session_id, seen); }
    if (!seen.has(path)) { seen.add(path); continue; }
    rereadCalls++;
    affected.add(r.session_id);
    wastedChars += r.result_chars ?? 0;
    const f = files.get(path) ?? { rereads: 0, sessions: new Set() };
    f.rereads++; f.sessions.add(r.session_id); files.set(path, f);
  }
  return {
    rereadCalls,
    sessionsAffected: affected.size,
    estWastedTokens: Math.round(wastedChars / 4),
    topFiles: [...files.entries()].map(([path, f]) => ({ path, rereads: f.rereads, sessions: f.sessions.size }))
      .sort((a, b) => b.rereads - a.rereads).slice(0, 10),
  };
}

export function computeWaste(days: number | null): WasteResult {
  return { cacheChurn: cacheChurn(days), rightSizing: rightSizing(days), rereads: rereads(days) };
}
