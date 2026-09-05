#!/usr/bin/env node
/**
 * /ask runner (CHI-351): one operator-initiated question -> one answered turn.
 * Rides the headless-runner seam
 * (findClaudeBin, a dedicated runner cwd, extractJson), but the model gets EXACTLY
 * one tool — the read-only SELECT-only query server (scripts/ask-db-mcp.ts) —
 * via the confined invocation verified in the CHI-351 spikes:
 *
 *   claude -p <prompt> --tools "" --mcp-config <cfg> \
 *          --allowedTools "mcp__chronicledb__query" --strict-mcp-config
 *
 * `--tools ""` is REQUIRED: without it the model keeps Bash/Read/network. The
 * model explores via the tool, runs its FINAL query LAST, then replies with a
 * JSON envelope {prose, sql, costBasis, note?}. The authoritative answer TABLE
 * is read from the MCP server's capture file (produced inside this killable
 * subprocess), never by re-running the model's SQL in the main server.
 *
 * Prints ONE AskTurn JSON object to stdout. Exit 0 = a turn (ok true or false);
 * exit 2 = infrastructure failure (no claude binary / no runner entry). Reads
 * the question from --question or $CHRONICLE_ASK_QUESTION, the basis from
 * --cost-mode or $CHRONICLE_ASK_COST_MODE_UI (list|billed). Flags: --dry-run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaudeBin, extractJson } from '../server/ask.ts';
import {
  askSchemaDoc, validateAskEnvelope, normalizeAskCostMode, toCostMode,
  pickCapture, askClaudeArgs, type AskCapture, type AskCostMode, type AskTurn,
} from '../server/ask.ts';

const RUN_TIMEOUT_MS = 90 * 1000; // short: node:sqlite has no query interrupt, so
                                  // this process timeout is the only DoS bound.
const DATA_DIR = process.env.CHRONICLE_DATA_DIR || join(homedir(), '.chronicle');

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Resolve the MCP server entry: compiled JS in the published package, else the
 * TS source in dev (Node 24 type-strips it). */
function mcpEntry(): string | null {
  const candidates = [
    new URL('./ask-db-mcp.js', import.meta.url),
    new URL('./ask-db-mcp.ts', import.meta.url),
  ].map((u) => fileURLToPath(u));
  return candidates.find((p) => existsSync(p)) ?? null;
}

function buildPrompt(question: string, costMode: AskCostMode): string {
  return [
    "You are Chronicle's headless /ask runner. Answer the user's question about their AI coding",
    'sessions using ONLY the `query` tool (read-only SQL over their local chronicle.db).',
    '',
    askSchemaDoc(costMode),
    '',
    `Question: ${question}`,
    '',
    'Explore with as many `query` calls as you need, but run your FINAL authoritative query LAST',
    '(its result becomes the answer table). Then reply with EXACTLY one JSON object, no prose outside',
    'it, no markdown fences:',
    '{"prose": "<a 1-3 sentence answer in plain English, citing the key figures>",',
    ' "sql": "<the final authoritative SELECT you ran, verbatim>",',
    ` "costBasis": "${costMode}",`,
    ' "note": "<optional caveat, e.g. a reconciliation or coverage note; omit if none>"}',
    'If you cannot answer from the database, still reply with that JSON, putting the reason in prose',
    'and an empty string for sql.',
  ].join('\n');
}

function emptyTurn(question: string, costBasis: AskCostMode, prose: string, error?: string): AskTurn {
  return {
    id: `ask_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    ts: new Date().toISOString(),
    question, costBasis, ok: !error, prose,
    sql: null, columns: [], rows: [], rowCount: 0, truncated: false,
    ...(error ? { error } : {}),
  };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const question = (flag(argv, '--question') ?? process.env.CHRONICLE_ASK_QUESTION ?? '').trim();
  const costMode = normalizeAskCostMode(flag(argv, '--cost-mode') ?? process.env.CHRONICLE_ASK_COST_MODE_UI);
  const dryRun = argv.includes('--dry-run');
  if (!question) { process.stdout.write(JSON.stringify(emptyTurn('', costMode, 'no question provided', 'empty question')) + '\n'); return 2; }

  const claude = findClaudeBin();
  const entry = mcpEntry();
  const runnerDir = join(DATA_DIR, 'runner');
  mkdirSync(runnerDir, { recursive: true });
  const capturePath = join(runnerDir, 'ask-queries.jsonl');
  const cfgPath = join(runnerDir, 'ask-mcp.json');

  const cfg = {
    mcpServers: {
      chronicledb: {
        type: 'stdio',
        command: process.execPath,
        args: [entry ?? ''],
        env: {
          CHRONICLE_DATA_DIR: DATA_DIR,
          CHRONICLE_ASK_RUNNER_DIR: runnerDir,
          CHRONICLE_ASK_COST_MODE: toCostMode(costMode),
          CHRONICLE_ASK_DAY: new Date().toISOString().slice(0, 10),
        },
      },
    },
  };
  const prompt = buildPrompt(question, costMode);
  const args = askClaudeArgs(prompt, cfgPath, process.env.CHRONICLE_ASK_MODEL);

  if (dryRun) {
    process.stdout.write(`[dry-run] ${claude ?? 'claude (NOT FOUND)'} ${JSON.stringify(args)}\ncfg=${JSON.stringify(cfg)}\n`);
    return 0;
  }
  if (!claude) { process.stdout.write(JSON.stringify(emptyTurn(question, costMode, 'the claude CLI was not found', 'no claude binary')) + '\n'); return 2; }
  if (!entry) { process.stdout.write(JSON.stringify(emptyTurn(question, costMode, 'the ask query server was not found', 'no mcp entry')) + '\n'); return 2; }

  // Fresh capture + config per run (the capture is the authoritative table).
  try { rmSync(capturePath, { force: true }); } catch { /* ignore */ }
  writeFileSync(cfgPath, JSON.stringify(cfg), 'utf-8');

  const run = spawnSync(claude, args, {
    cwd: runnerDir, encoding: 'utf-8', timeout: RUN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], // stdin ignored: claude -p won't wait on it
    killSignal: 'SIGKILL', // hard-kill on timeout: node:sqlite has no interrupt
    env: process.env,
  });
  if (run.error || run.status !== 0) {
    const why = run.error?.message?.includes('ETIMEDOUT') ? `timed out after ${RUN_TIMEOUT_MS / 1000}s`
      : (run.stderr || run.error?.message || `claude exited ${run.status}`).trim().slice(0, 300);
    process.stdout.write(JSON.stringify(emptyTurn(question, costMode, `the query run failed (${why})`, why)) + '\n');
    return 0;
  }

  let envelope;
  try { envelope = validateAskEnvelope(extractJson(run.stdout)); }
  catch (err) {
    process.stdout.write(JSON.stringify(emptyTurn(question, costMode,
      "couldn't parse an answer from the query run", err instanceof Error ? err.message : String(err))) + '\n');
    return 0;
  }

  let captures: AskCapture[] = [];
  try {
    captures = readFileSync(capturePath, 'utf-8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as AskCapture);
  } catch { /* no captures (model answered without a successful query) */ }
  const table = pickCapture(captures, envelope.sql);

  const turn: AskTurn = {
    id: `ask_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    ts: new Date().toISOString(),
    question, costBasis: costMode, ok: true,
    prose: envelope.prose,
    sql: table?.sql ?? (envelope.sql || null),
    columns: table?.columns ?? [],
    rows: table?.rows ?? [],
    rowCount: table?.rowCount ?? 0,
    truncated: table?.truncated ?? false,
    ...(envelope.note ? { note: envelope.note } : {}),
  };
  process.stdout.write(JSON.stringify(turn) + '\n');
  return 0;
}

if (import.meta.main) process.exit(main());
