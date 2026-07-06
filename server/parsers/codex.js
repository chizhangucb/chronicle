import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

// Codex CLI writes rollout-*.jsonl files (possibly nested by date).
export function scanCodexProjects(baseDir = CODEX_SESSIONS_DIR) {
  if (!fs.existsSync(baseDir)) return [];
  const files = [];
  (function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full);
      else if (d.name.endsWith('.jsonl')) files.push(full);
    }
  })(baseDir);
  if (!files.length) return [];
  // Group by cwd sniffed from each file
  const groups = new Map();
  for (const f of files) {
    const cwd = sniffCodexCwd(f) || 'unknown';
    if (!groups.has(cwd)) groups.set(cwd, []);
    groups.get(cwd).push(f);
  }
  return [...groups.entries()].map(([cwd, fs_]) => ({
    source: 'codex',
    logDir: baseDir,
    files: fs_,
    name: cwd === 'unknown' ? 'Codex sessions' : path.basename(cwd),
    physicalPath: cwd === 'unknown' ? null : cwd,
    sessionCount: fs_.length,
    messageEstimate: fs_.length * 40,
    sessions: fs_.map((f) => {
      let mtime = null;
      try { mtime = fs.statSync(f).mtime.toISOString(); } catch {}
      return { id: path.basename(f, '.jsonl'), file: f, label: null, modifiedAt: mtime, messageEstimate: 40 };
    }).sort((a, b) => ((a.modifiedAt || '') < (b.modifiedAt || '') ? 1 : -1)),
  }));
}

function sniffCodexCwd(file) {
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

export async function parseCodexSession(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const events = [];
  let sessionId = path.basename(file, '.jsonl');
  let cwd = null;
  let firstPrompt = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp || o.ts || null;
    const p = o.payload || o;
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
    }
  }

  const timestamps = events.map((e) => e.ts).filter(Boolean).sort();
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

function itemText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => c.text || c.input_text || c.output_text || '').filter(Boolean).join('\n');
  }
  return '';
}
