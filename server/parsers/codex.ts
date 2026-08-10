import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { Event, ParseResult, ScannedProject } from '../../shared/types.ts';

export const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

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
}

interface CodexLine {
  timestamp?: string;
  ts?: string;
  type?: string;
  payload?: CodexPayload;
}

// Codex CLI writes rollout-*.jsonl files (possibly nested by date).
export function scanCodexProjects(baseDir: string = CODEX_SESSIONS_DIR): ScannedProject[] {
  if (!fs.existsSync(baseDir)) return [];
  const files: string[] = [];
  (function walk(dir: string): void {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.name.endsWith('.jsonl')) files.push(full);
    }
  })(baseDir);
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

export async function parseCodexSession(file: string): Promise<ParseResult> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const events: Event[] = [];
  let sessionId = path.basename(file, '.jsonl');
  let cwd: string | null = null;
  let firstPrompt: string | null = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: CodexLine;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp || o.ts || null;
    const p: CodexPayload = o.payload || (o as unknown as CodexPayload);
    if (p.id && p.cwd) { cwd = p.cwd; if (p.id) sessionId = p.id; }
    const t = p.type || o.type;
    if (t === 'message' && p.role === 'user') {
      const text = itemText(p.content);
      if (text) { events.push({ ts, kind: 'user', text }); if (!firstPrompt) firstPrompt = text.slice(0, 200); }
    } else if (t === 'message' && p.role === 'assistant') {
      const text = itemText(p.content);
      if (text) events.push({ ts, kind: 'assistant', text });
    } else if (t === 'reasoning') {
      const text = (p.summary || []).map((s) => s.text || '').join('\n');
      if (text) events.push({ ts, kind: 'thinking', text });
    } else if (t === 'function_call' || t === 'local_shell_call') {
      events.push({ ts, kind: 'tool_use', tool_name: p.name || 'shell', tool_input: p.arguments || JSON.stringify(p.action || {}), tool_use_id: p.call_id });
    } else if (t === 'function_call_output') {
      events.push({ ts, kind: 'tool_result', text: typeof p.output === 'string' ? p.output : JSON.stringify(p.output), tool_use_id: p.call_id });
    } else if (t === 'token_count' && p.info?.last_token_usage) {
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
