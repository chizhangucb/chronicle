/**
 * /ask (CHI-351) - the testable core, shared by the stdio MCP server
 * (scripts/ask-db-mcp.ts), the runner (scripts/run-ask.ts) and the route
 * (server/routes/ask.ts). Pure functions only here (no db handle, no spawn) so
 * node --test can exercise the SELECT-only guard, the caps, the envelope
 * validator and history pruning without a database or a claude binary.
 *
 * Posture (verified spikes, see the CHI-351 workstate): the model runs one MCP
 * tool `query({sql})` over a READ-ONLY chronicle.db handle - that handle is the
 * HARD SELECT-only guarantee (writes/ATTACH/load_extension all fail at the
 * SQLite layer; the fs functions aren't even compiled into node:sqlite). The
 * guard below is defense-in-depth + clean errors, NOT the security boundary.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CostMode } from '../shared/pricing.ts';

// ---- caps (result-size, review #5/#8) ------------------------------------
export const ASK_MAX_ROWS = 500;       // rows returned to the model / stored
export const ASK_CELL_MAX = 2000;      // chars per cell before truncation
export const ASK_RESP_MAX_BYTES = 256 * 1024; // hard cap on one tool response

// ---- cost basis ----------------------------------------------------------
// The UI/user speak "list"/"billed"; the price core speaks "theoretical"/"real".
export type AskCostMode = 'list' | 'billed';
export function toCostMode(m: AskCostMode): CostMode {
  return m === 'billed' ? 'real' : 'theoretical';
}
export function costBasisLabel(m: AskCostMode): string {
  return m === 'billed' ? 'Billed' : 'List price';
}
export function normalizeAskCostMode(v: unknown): AskCostMode {
  return v === 'billed' || v === 'real' ? 'billed' : 'list';
}

// ---- SELECT-only guard (defense-in-depth) --------------------------------
/** Strip SQL line and block comments so a leading comment can't smuggle a
 * non-SELECT past the prefix check. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
}

export interface SanitizeOk { ok: true; sql: string; }
export interface SanitizeErr { ok: false; error: string; }
/** Accepts a SINGLE read-only SELECT/WITH statement. Rejects everything else
 * with a clean message. The read-only handle is the real guarantee; this exists
 * so the model gets "only SELECT is allowed" instead of a raw SQLite error, and
 * so a stray second statement never runs. */
export function sanitizeAskSql(raw: unknown): SanitizeOk | SanitizeErr {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'sql must be a non-empty string' };
  const stripped = stripSqlComments(raw);
  if (!stripped) return { ok: false, error: 'sql is only comments' };
  // Allow a single trailing semicolon; any other semicolon means multiple
  // statements (node:sqlite runs only the first, silently - reject instead).
  const noTrailing = stripped.replace(/;\s*$/, '');
  if (noTrailing.includes(';')) return { ok: false, error: 'only a single statement is allowed (no ";")' };
  if (!/^(select|with)\b/i.test(noTrailing)) return { ok: false, error: 'only SELECT / WITH queries are allowed' };
  // Belt-and-suspenders keyword deny (these already fail on a read-only handle):
  if (/\b(attach|detach|pragma|vacuum)\b/i.test(noTrailing)) return { ok: false, error: 'ATTACH / DETACH / PRAGMA / VACUUM are not allowed' };
  return { ok: true, sql: noTrailing };
}

/** Wrap a sanitized query so the SQLite engine itself stops after ASK_MAX_ROWS+1
 * rows - bounds a plain `SELECT ... cross join` before it materializes (a heavy
 * GROUP BY still scans, so the process timeout is the ultimate DoS bound). */
export function wrapLimited(sql: string, max = ASK_MAX_ROWS): string {
  return `SELECT * FROM (\n${sql}\n) AS _ask LIMIT ${max + 1}`;
}

// ---- result shaping ------------------------------------------------------
export interface AskResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;   // rows returned (post-cap)
  truncated: boolean; // more rows existed than returned
}

/** Turn node:sqlite object-rows into capped column/row arrays. `hadExtra` = the
 * wrapped query returned more than ASK_MAX_ROWS (the +1 sentinel row). */
export function shapeRows(objRows: Record<string, unknown>[], hadExtra: boolean, max = ASK_MAX_ROWS): AskResult {
  const capped = objRows.slice(0, max);
  const columns = capped.length ? Object.keys(capped[0]) : [];
  const rows = capped.map((r) => columns.map((c) => capCell(r[c])));
  let result: AskResult = { columns, rows, rowCount: rows.length, truncated: hadExtra };
  // Byte cap: drop rows from the tail until the payload fits.
  while (JSON.stringify(result).length > ASK_RESP_MAX_BYTES && result.rows.length > 0) {
    result = { ...result, rows: result.rows.slice(0, -1), rowCount: result.rows.length - 1, truncated: true };
  }
  return result;
}

function capCell(v: unknown): unknown {
  if (typeof v === 'string' && v.length > ASK_CELL_MAX) return v.slice(0, ASK_CELL_MAX) + '...';
  if (typeof v === 'bigint') return Number(v); // node:sqlite may return BigInt for INTEGER
  return v;
}

// ---- schema doc (single source of truth for the prompt) ------------------
// Describes EXACTLY the read-only surface scripts/ask-db-mcp.ts exposes. Kept
// here so the runner prompt and the MCP server's TEMP objects stay in lockstep
// (the MCP server builds `pricing`, `session_model_cost`, `message_cost`; the
// base tables/contract views already exist in chronicle.db).
export function askSchemaDoc(costMode: AskCostMode): string {
  const basis = costBasisLabel(costMode);
  return [
    `You may run read-only SELECT queries over Chronicle's SQLite. Cost basis for THIS run: ${basis}.`,
    'All $ figures below are already priced at that basis (Billed => subscription-covered models bill $0).',
    '',
    'PREFERRED cost surfaces (already deduped - these RECONCILE with the Insights dashboards):',
    '- session_model_cost(session_id, project_path, source, started_at, ended_at, day, usage_source,',
    '    model, input_tokens, output_tokens, cache_read_tokens, cache_w5m_tokens, cache_w1h_tokens, cost_usd)',
    '    One row per (session, model) from the deduped sessions.usage totals. USE THIS for session / project /',
    '    model spend so your numbers match the dashboards. `day` = date(started_at|ended_at).',
    '- message_cost(session_id, seq, ts, day, model, kind, tool_name, mcp_server, skill, is_sidechain,',
    '    agent_type, agent_id, workflow_id, project_path, source, input_tokens, output_tokens,',
    '    cache_read_tokens, cache_w5m_tokens, cache_w1h_tokens, cost_usd)',
    '    Per-message, deduped (replayed rows were nulled by CHI-286). USE THIS for finer breakdowns:',
    '    subagents (is_sidechain=1, group by agent_type), tools (tool_name / mcp_server), skills, by day.',
    '    Reconciles for exact/rederived sessions; may differ slightly for legacy usage_source=\'unverified\'.',
    '- pricing(model, input, output, cw5m, cw1h, cache_read): per-MTok rates used above (transparency).',
    '',
    'Base tables / contract views (raw; do NOT SUM message token columns yourself for cost - prefer the',
    'surfaces above): projects(id,path,name); sessions(id,project_id,source,started_at,ended_at,',
    'message_count,minor,usage,usage_source,agent_active_ms,engaged_ms,...); messages(session_id,seq,ts,kind,',
    'text,tool_name,model,is_sidechain,agent_type,skill,...); contract_sessions; contract_message_metrics.',
    '',
    'Rules: one SELECT/WITH statement per query call; results are capped at',
    `${ASK_MAX_ROWS} rows. Explore as many queries as you need, then run your FINAL authoritative query LAST.`,
  ].join('\n');
}

// ---- the model's answer envelope -----------------------------------------
export interface AskEnvelope {
  prose: string;
  sql: string;
  costBasis: AskCostMode;
  note?: string;
}
/** Validate the JSON the model must reply with (after using the query tool).
 * Throws with a clean message the route renders as a failed turn (review #9). */
export function validateAskEnvelope(value: unknown): AskEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('reply is not a JSON object');
  }
  const v = value as Record<string, unknown>;
  if (typeof v.prose !== 'string' || !v.prose.trim()) throw new Error('prose: expected a non-empty string');
  if (typeof v.sql !== 'string' || !v.sql.trim()) throw new Error('sql: expected a non-empty string');
  return {
    prose: v.prose.trim(),
    sql: v.sql.trim(),
    costBasis: normalizeAskCostMode(v.costBasis),
    ...(typeof v.note === 'string' && v.note.trim() ? { note: v.note.trim() } : {}),
  };
}

// ---- a persisted conversation turn ---------------------------------------
export interface AskTurn {
  id: string;
  ts: string;               // ISO
  question: string;
  costBasis: AskCostMode;
  ok: boolean;
  prose: string;
  sql: string | null;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  note?: string;
  error?: string;           // set when ok === false
}

// ---- durable history (~/.chronicle/ask-history.jsonl) --------------------
export const ASK_HISTORY_MAX = 500; // newest N turns kept

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CHRONICLE_DATA_DIR || join(homedir(), '.chronicle');
}
export function askHistoryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), 'ask-history.jsonl');
}

/** Parse one turn per line; skip malformed lines. Newest last (append order). */
export function parseHistory(text: string): AskTurn[] {
  const out: AskTurn[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj.id === 'string' && typeof obj.question === 'string') out.push(obj as AskTurn);
    } catch { /* skip */ }
  }
  return out;
}

export function readAskHistory(env: NodeJS.ProcessEnv = process.env): AskTurn[] {
  try { return parseHistory(readFileSync(askHistoryPath(env), 'utf-8')); } catch { return []; }
}

/** Append a turn, then rewrite the file keeping only the newest ASK_HISTORY_MAX
 * (bounded growth, review D4). We always rewrite (that's how pruning happens).
 * Best-effort: a write failure never throws into the request path. */
export function appendAskTurn(turn: AskTurn, env: NodeJS.ProcessEnv = process.env): void {
  const path = askHistoryPath(env);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const kept = [...readAskHistory(env), turn].slice(-ASK_HISTORY_MAX);
    writeFileSync(path, kept.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf-8');
  } catch { /* history is best-effort */ }
}
