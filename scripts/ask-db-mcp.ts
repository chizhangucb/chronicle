#!/usr/bin/env node
/**
 * /ask — the ONE tool the headless `claude -p` runner is allowed.
 * A minimal stdio JSON-RPC MCP server (no SDK dependency, matching Chronicle's
 * lean-deps posture) exposing a single tool `query({sql})` over a READ-ONLY
 * chronicle.db handle.
 *
 * The read-only handle is the HARD server-side SELECT-only guarantee (verified
 * in the spikes: writes / ATTACH / load_extension all fail at the SQLite
 * layer, and readfile/writefile aren't compiled into node:sqlite, so there is no
 * fs escape). sanitizeAskSql is defense-in-depth + clean errors, not the wall.
 *
 * On startup it builds, in the TEMP schema (writable even on a read-only main
 * db, so chronicle.db is never touched): a `pricing` table for the run's cost
 * basis, and two deduped cost views the schema-prompt steers the model to —
 * `session_model_cost` (from sessions.usage, reconciles with the dashboards) and
 * `message_cost` (per-message, replayed rows already nulled).
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
import { type CostMode } from '../shared/pricing.ts';
import { sanitizeAskSql, wrapLimited, shapeRows, ASK_MAX_ROWS } from '../server/ask.ts';
import { buildCostSurface } from '../server/askDb.ts';

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
  buildCostSurface(db, COST_MODE, DAY, warn);
} catch (err) {
  warn(`db init failed: ${(err as Error).message}`);
  db = null; // the query tool then reports the error per-call
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
