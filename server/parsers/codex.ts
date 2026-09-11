import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { Event, ParseResult, ScannedProject } from '../../shared/types.ts';
import { addCellInto, type UsageByModel } from '../../shared/usage.ts';
import { isSyntheticUserText } from '../../shared/synthetic.ts';
import type { Source } from './source.ts';
import { newestMtimeMs } from './source.ts';

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

interface CodexContentItem {
  text?: string;
  input_text?: string;
  output_text?: string;
}

interface CodexTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
}

interface CodexPayload {
  id?: string;
  cwd?: string;
  type?: string;
  role?: string;
  content?: string | CodexContentItem[];
  summary?: { text?: string }[];
  name?: string;
  arguments?: string;
  action?: unknown;
  call_id?: string;
  output?: unknown;
  info?: { last_token_usage?: CodexTokenUsage };
  // The model Codex ran the turn on. It is recorded on the rollout's CONTEXT
  // lines (the `turn_context` item, and the session meta on the versions that
  // carry it there), never on the response items themselves — so a model
  // output's model is the last one the transcript recorded before it (#198).
  model?: string;
}

interface CodexLine {
  timestamp?: string;
  ts?: string;
  type?: string;
  payload?: CodexPayload;
}

// Every transcript under a Codex sessions root, which nests them by date
// (<root>/YYYY/MM/DD/rollout-*.jsonl). Any .jsonl counts, not just the
// rollout-* spelling — a name is not a format.
function codexTranscriptFiles(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) return [];
  const files: string[] = [];
  (function walk(dir: string): void {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.name.endsWith('.jsonl')) files.push(full);
    }
  })(baseDir);
  return files;
}

// Codex CLI writes rollout-*.jsonl files (possibly nested by date).
function scanCodexProjects(baseDir: string = CODEX_SESSIONS_DIR): ScannedProject[] {
  const files = codexTranscriptFiles(baseDir);
  if (!files.length) return [];
  // Group by cwd sniffed from each file
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const cwd = sniffCodexCwd(f) || 'unknown';
    if (!groups.has(cwd)) groups.set(cwd, []);
    (groups.get(cwd) as string[]).push(f);
  }
  return [...groups.entries()].map(([cwd, fs_]): ScannedProject => ({
    source: 'codex',
    logDir: baseDir,
    files: fs_,
    name: cwd === 'unknown' ? 'Codex sessions' : path.basename(cwd),
    physicalPath: cwd === 'unknown' ? null : cwd,
    sessionCount: fs_.length,
    messageEstimate: fs_.length * 40,
    sessions: fs_.map((f) => {
      let mtime: string | null = null;
      try { mtime = fs.statSync(f).mtime.toISOString(); } catch {}
      return { id: path.basename(f, '.jsonl'), file: f, label: null, modifiedAt: mtime, messageEstimate: 40 };
    }).sort((a, b) => ((a.modifiedAt || '') < (b.modifiedAt || '') ? 1 : -1)),
  }));
}

function sniffCodexCwd(file: string): string | null {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(32 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"cwd":\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return JSON.parse(`"${m[1]}"`);
  } catch {}
  return null;
}

// The model one rollout line records, if it records one. Codex writes it as the
// payload's own `model` field, on whichever context line the version in hand
// carries (a `turn_context` item, or the session meta) — so the field is read
// off any line rather than off one line type. A blank or non-string value
// records nothing, and a transcript that records no model anywhere imports the
// way it did before: unmodeled rows, and no usage aggregate to price.
function recordedModel(p: CodexPayload): string | null {
  return typeof p.model === 'string' && p.model.trim() ? p.model.trim() : null;
}

// One rollout line to its events. Shared by the whole-file parse above and by
// the source's `tail`, so a streamed line and an imported one map to the same
// kinds, text and ids. `model` is the turn's model as recorded by an EARLIER
// line (#198): a model output (assistant / thinking / tool_use) is stamped with
// it, a user message is not, since that one is the operator's. `tail` sees one
// line with no memory of the ones before it, so a live-streamed row carries no
// model until the session is synced and re-parsed whole.
function parseCodexLine(o: CodexLine, model: string | null = null): Event[] {
  const ts = o.timestamp || o.ts || null;
  const p: CodexPayload = o.payload || (o as unknown as CodexPayload);
  const t = p.type || o.type;
  if (t === 'message' && p.role === 'user') {
    const text = itemText(p.content);
    return text ? [{ ts, kind: 'user', text }] : [];
  }
  if (t === 'message' && p.role === 'assistant') {
    const text = itemText(p.content);
    return text ? [{ ts, kind: 'assistant', text, model }] : [];
  }
  if (t === 'reasoning') {
    const text = (p.summary || []).map((s) => s.text || '').join('\n');
    return text ? [{ ts, kind: 'thinking', text, model }] : [];
  }
  if (t === 'function_call' || t === 'local_shell_call') {
    return [{ ts, kind: 'tool_use', model, tool_name: p.name || 'shell', tool_input: p.arguments || JSON.stringify(p.action || {}), tool_use_id: p.call_id }];
  }
  if (t === 'function_call_output') {
    return [{ ts, kind: 'tool_result', text: typeof p.output === 'string' ? p.output : JSON.stringify(p.output), tool_use_id: p.call_id }];
  }
  return [];
}

async function parseCodexSession(file: string): Promise<ParseResult> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const events: Event[] = [];
  let sessionId = path.basename(file, '.jsonl');
  let cwd: string | null = null;
  let firstPrompt: string | null = null;
  let model: string | null = null;
  // Per-model billed totals, summed from the SAME numbers the per-message
  // columns get, so SUM(messages) == sessions.usage for a Codex session too.
  // Only a turn whose model Codex recorded can be aggregated: a cell keyed by
  // a made-up model name would price a guess, so those tokens stay on the
  // message rows alone (#198).
  const usageByModel: UsageByModel = {};

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: CodexLine;
    try { o = JSON.parse(line); } catch { continue; }
    const p: CodexPayload = o.payload || (o as unknown as CodexPayload);
    if (p.id && p.cwd) { cwd = p.cwd; if (p.id) sessionId = p.id; }
    const t = p.type || o.type;
    // A recorded model holds until the transcript records another one (the
    // operator switching model mid-session writes a fresh turn context).
    model = recordedModel(p) ?? model;
    for (const e of parseCodexLine(o, model)) {
      events.push(e);
      // Push every user row (active-time needs them); only the display-name
      // fallback skips synthetic wrappers.
      if (e.kind === 'user' && !firstPrompt && e.text && !isSyntheticUserText(e.text)) firstPrompt = e.text.slice(0, 200);
    }
    if (t === 'token_count' && p.info?.last_token_usage) {
      // Per-message usage: a token_count event reports the API call that produced
      // the most recent model output — attach to it (Codex input_tokens include
      // the cached portion; split it out to match the CC column semantics).
      const u = p.info.last_token_usage;
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.input_tokens != null) break;
        if (e.kind === 'assistant' || e.kind === 'thinking' || e.kind === 'tool_use') {
          e.input_tokens = Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
          e.output_tokens = u.output_tokens || 0;
          e.cache_read_tokens = u.cached_input_tokens || 0;
          e.cache_w5m_tokens = u.cache_write_input_tokens || 0;
          if (e.model) addCellInto(usageByModel, e.model, {
            input: e.input_tokens, output: e.output_tokens, cacheRead: e.cache_read_tokens,
            cacheWrite5m: e.cache_w5m_tokens, cacheWrite1h: 0,
          });
          break;
        }
      }
    }
  }

  const timestamps = events.map((e) => e.ts).filter(Boolean).sort() as string[];
  return {
    session: {
      id: `codex-${sessionId}`,
      source: 'codex',
      file_path: file,
      cwd,
      started_at: timestamps[0] ?? null,
      ended_at: timestamps[timestamps.length - 1] ?? null,
      first_prompt: firstPrompt,
      usage: Object.keys(usageByModel).length ? JSON.stringify(usageByModel) : null,
      skipped: 0,
    },
    events,
  };
}

function itemText(content: string | CodexContentItem[] | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text || c.input_text || c.output_text || '').filter(Boolean).join('\n');
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// The Source interface (#308)

// Codex is a per-file source: one rollout JSONL per session, nested by date
// under the sessions root and appended to as the session runs — so it tails.
export const codexSource: Source = {
  id: 'codex',

  defaultRoot: () => CODEX_SESSIONS_DIR,

  scan: (root: string = CODEX_SESSIONS_DIR): ScannedProject[] => scanCodexProjects(root),

  // A target with neither files nor a log dir names nothing, so it parses
  // nothing — the sessions root is where `scan` starts, not a parse fallback.
  async parse({ logDir, files }): Promise<ParseResult[]> {
    const sessionFiles = files?.length
      ? files.filter((f) => fs.existsSync(f))
      : logDir ? codexTranscriptFiles(logDir) : [];
    const parsed: ParseResult[] = [];
    for (const f of sessionFiles) parsed.push(await parseCodexSession(f));
    return parsed;
  },

  mtime: (file: string): number | null => newestMtimeMs(file),

  tail(line: string): Event[] {
    try { return parseCodexLine(JSON.parse(line) as CodexLine); } catch { return []; }
  },
};
