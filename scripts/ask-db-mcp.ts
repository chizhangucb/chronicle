#!/usr/bin/env node
/**
 * /ask (CHI-351) — the ONE tool the headless `claude -p` runner is allowed.
 * A minimal stdio JSON-RPC MCP server (no SDK dependency, matching Chronicle's
 * lean-deps posture) exposing a single tool `query({sql})` over a READ-ONLY
 * chronicle.db handle.
 *
 * The read-only handle is the HARD server-side SELECT-only guarantee (verified
 * in the CHI-351 spikes: writes / ATTACH / load_extension all fail at the SQLite
 * layer, and readfile/writefile aren't compiled into node:sqlite, so there is no
 * fs escape). sanitizeAskSql is defense-in-depth + clean errors, not the wall.
 *
 * On startup it builds, in the TEMP schema (writable even on a read-only main
 * db, so chronicle.db is never touched): a `pricing` table for the run's cost
 * basis, and two deduped cost views the schema-prompt steers the model to —
 * `session_model_cost` (from sessions.usage, reconciles with the dashboards) and
 * `message_cost` (per-message, replayed rows already nulled by CHI-286).
 *
 * Every successful query APPENDS its (already-capped) result to
 * `<runnerDir>/ask-queries.jsonl`. That capture — produced inside THIS
 * spawnSync-killable subprocess — is the authoritative answer table; the main
 * server never re-executes model SQL (would be an unbounded DoS: node:sqlite has
 * no query interrupt).
 */
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pricingFor, type CostMode } from '../shared/pricing.ts';
import { sanitizeAskSql, wrapLimited, shapeRows, ASK_MAX_ROWS } from '../server/ask.ts';

const DATA_DIR = process.env.CHRONICLE_DATA_DIR || join(homedir(), '.chronicle');
const RUNNER_DIR = process.env.CHRONICLE_ASK_RUNNER_DIR || join(DATA_DIR, 'runner');
const CAPTURE = join(RUNNER_DIR, 'ask-queries.jsonl');
const COST_MODE: CostMode =
  process.env.CHRONICLE_ASK_COST_MODE === 'real' || process.env.CHRONICLE_ASK_COST_MODE === 'billed'
    ? 'real' : 'theoretical';
const DAY = process.env.CHRONICLE_ASK_DAY || new Date().toISOString().slice(0, 10);

const send = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n'); };
const warn = (m: string): void => { try { process.stderr.write(`[ask-db-mcp] ${m}\n`); } catch { /* ignore */ } };

// ---- open the db read-only + build the TEMP cost surface -----------------
let db: DatabaseSync | null = null;
try {
  const dbPath = join(DATA_DIR, 'chronicle.db');
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  db = new DatabaseSync(dbPath, { readOnly: true });
  buildCostSurface(db);
} catch (err) {
  warn(`db init failed: ${(err as Error).message}`);
  db = null; // the query tool then reports the error per-call
}

function distinctModels(d: DatabaseSync): string[] {
  const set = new Set<string>();
  const add = (sql: string): void => {
    try {
      for (const r of d.prepare(sql).all() as Array<{ m: unknown }>) if (r.m) set.add(String(r.m));
    } catch { /* json1 or column may be absent on an odd build; degrade */ }
  };
  add(`SELECT DISTINCT je.key AS m FROM sessions, json_each(usage) je WHERE usage IS NOT NULL`);
  add(`SELECT DISTINCT model AS m FROM messages WHERE model IS NOT NULL`);
  return [...set];
}

function buildCostSurface(d: DatabaseSync): void {
  // pricing (TEMP): one row per DISTINCT concrete model, resolved through the
  // single price source for THIS run's basis. Billed => covered models price $0.
  d.exec(`CREATE TEMP TABLE pricing(
    model TEXT PRIMARY KEY, input REAL, output REAL, cw5m REAL, cw1h REAL, cache_read REAL)`);
  const ins = d.prepare(`INSERT OR IGNORE INTO pricing VALUES (?,?,?,?,?,?)`);
  for (const m of distinctModels(d)) {
    const p = pricingFor(m, DAY, COST_MODE);
    if (p) ins.run(m, p.input, p.output, p.cw5m, p.cw1h, p.cacheRead);
  }
  // session_model_cost: deduped per-(session,model) from sessions.usage, priced.
  // Reconciles with the Insights dashboards (same source). Legacy `cacheWrite`
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
  } catch (err) { warn(`session_model_cost unavailable: ${(err as Error).message}`); }
  // message_cost: per-message, deduped (CHI-286 nulled replayed token rows, and
  // every column is COALESCEd), priced. For subagent / tool / skill / by-day cuts.
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
  } catch (err) { warn(`message_cost unavailable: ${(err as Error).message}`); }
}

// ---- the query tool ------------------------------------------------------
interface QueryResult { columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean; }
function runQuery(sqlRaw: unknown): QueryResult | { error: string } {
  if (!db) return { error: 'the Chronicle database is not available' };
  const clean = sanitizeAskSql(sqlRaw);
  if (!clean.ok) return { error: clean.error };
  let objRows: Record<string, unknown>[];
  try {
    objRows = db.prepare(wrapLimited(clean.sql)).all() as Record<string, unknown>[];
  } catch (err) {
    return { error: (err as Error).message.slice(0, 500) };
  }
  const result = shapeRows(objRows, objRows.length > ASK_MAX_ROWS);
  try {
    mkdirSync(RUNNER_DIR, { recursive: true });
    appendFileSync(CAPTURE, JSON.stringify({ sql: clean.sql, ...result, ts: new Date().toISOString() }) + '\n');
  } catch (err) { warn(`capture failed: ${(err as Error).message}`); }
  return result;
}

const TOOL = {
  name: 'query',
  description:
    'Run ONE read-only SELECT/WITH query over Chronicle\'s SQLite and get columns + rows back. ' +
    `Results are capped at ${ASK_MAX_ROWS} rows. Only SELECT/WITH is allowed. Argument: {sql: string}.`,
  inputSchema: {
    type: 'object',
    properties: { sql: { type: 'string', description: 'A single read-only SELECT or WITH statement.' } },
    required: ['sql'],
  },
};

// ---- stdio JSON-RPC loop -------------------------------------------------
createInterface({ input: process.stdin }).on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try { msg = JSON.parse(t); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params?.protocolVersion as string) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'chronicledb', version: '1.0.0' },
    }});
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
  } else if (method === 'tools/call') {
    const name = params?.name;
    if (name !== 'query') {
      send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `unknown tool: ${String(name)}` }] } });
      return;
    }
    const out = runQuery((params?.arguments as Record<string, unknown> | undefined)?.sql);
    const isError = 'error' in out;
    send({ jsonrpc: '2.0', id, result: {
      ...(isError ? { isError: true } : {}),
      content: [{ type: 'text', text: JSON.stringify(out) }],
    }});
  } else if (method === 'notifications/initialized' || method == null) {
    // notification: no response
  } else if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
