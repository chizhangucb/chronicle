import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Scan ~/.claude/projects for importable projects with session/message estimates.
export function scanClaudeProjects(baseDir = CLAUDE_PROJECTS_DIR) {
  if (!fs.existsSync(baseDir)) return [];
  const results = [];
  for (const dirent of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const logDir = path.join(baseDir, dirent.name);
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) continue;
    let messageEstimate = 0;
    let physicalPath = null;
    const sessions = [];
    for (const f of files) {
      const full = path.join(logDir, f);
      const stat = fs.statSync(full);
      const est = Math.max(1, Math.round(stat.size / 2000));
      messageEstimate += est;
      const head = sniffHead(full);
      if (!physicalPath && head.cwd) physicalPath = head.cwd;
      sessions.push({
        id: path.basename(f, '.jsonl'),
        file: full,
        label: head.summary,
        modifiedAt: stat.mtime.toISOString(),
        messageEstimate: est,
      });
    }
    sessions.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
    results.push({
      source: 'claude-code',
      logDir,
      name: physicalPath ? path.basename(physicalPath) : dirent.name,
      physicalPath,
      sessionCount: files.length,
      messageEstimate,
      sessions,
    });
  }
  return results.sort((a, b) => b.sessionCount - a.sessionCount);
}

// Read the first and last few KB of a JSONL file to find the project's real cwd
// and a human label (the "summary" line Claude Code prepends to session logs).
// The cwd comes from the TAIL: sessions resumed after a repo move keep the old
// path in their early records, and the latest cwd is where the project (and its
// Git history) lives now. Falls back to the head when the tail has no cwd.
function sniffHead(file) {
  const head = { cwd: null, summary: null };
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const headText = buf.toString('utf8', 0, n);
    let tailText = '';
    if (size > n) {
      const tn = fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
      tailText = buf.toString('utf8', 0, tn);
    }
    fs.closeSync(fd);
    for (const line of headText.split('\n')) {
      if (!head.cwd) {
        const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (m) try { head.cwd = JSON.parse(`"${m[1]}"`); } catch {}
      }
      if (!head.summary) {
        const s = line.match(/^\{"type":"summary","summary":"((?:[^"\\]|\\.)*)"/);
        if (s) try { head.summary = JSON.parse(`"${s[1]}"`).slice(0, 120); } catch {}
      }
      if (head.cwd && head.summary) break;
    }
    const tailCwds = [];
    for (const m of tailText.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
      try { tailCwds.push(JSON.parse(`"${m[1]}"`)); } catch {}
    }
    if (tailCwds.length) head.cwd = reduceCwd(tailCwds[tailCwds.length - 1], new Set(tailCwds.concat(head.cwd || [])));
  } catch {}
  return head;
}

// A session can record subdirectory cwds (e.g. <repo>/server). Walk the pick up
// to the shortest seen ancestor so grouping lands on the project root.
function reduceCwd(pick, seen) {
  let out = pick;
  for (const c of seen) {
    if (c && c !== out && out.startsWith(c + '/')) out = c;
  }
  return out;
}

// Parse a single JSONL entry into normalized events (shared by import + live tail).
export function parseClaudeLine(o) {
  const events = [];
  if (o.isSidechain) return events;
  if (o.type === 'user' && o.message) {
    const content = o.message.content;
    if (typeof content === 'string') {
      if (content.startsWith('<command-name>') || content.startsWith('<local-command')) return events;
      events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'user', text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'tool_result',
            text: blockText(block.content), tool_use_id: block.tool_use_id });
        } else if (block.type === 'text' && block.text?.trim() && !block.text.startsWith('<system-reminder>')) {
          events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'user', text: block.text });
        }
      }
    }
  } else if (o.type === 'assistant' && o.message) {
    const model = o.message.model;
    for (const block of o.message.content || []) {
      if (block.type === 'text' && block.text?.trim()) {
        events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'assistant', text: block.text, model });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'thinking', text: block.thinking, model });
      } else if (block.type === 'tool_use') {
        events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'tool_use', model,
          tool_name: block.name, tool_use_id: block.id, tool_input: safeStringify(block.input) });
      }
    }
  }
  return events;
}

// Parse one session JSONL file into { session, events }.
export async function parseClaudeSession(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const events = [];
  let sessionId = path.basename(file, '.jsonl');
  let cwd = null;
  const cwdsSeen = new Set();
  let firstPrompt = null;
  let skipped = 0;
  let contextTokens = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { skipped++; continue; }
    if (o.sessionId) sessionId = o.sessionId;
    // Latest cwd wins: sessions resumed after a repo move carry the old path in
    // their early records; the newest cwd is where the project lives now.
    if (o.cwd) { cwd = o.cwd; cwdsSeen.add(o.cwd); }
    // Real context-window size: the prompt side of the LAST main-chain API call
    // (matches Claude Code's own status line; sidechains are separate contexts).
    if (!o.isSidechain && o.type === 'assistant' && o.message?.usage) {
      const u = o.message.usage;
      const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      if (ctx > 0) contextTokens = ctx;
    }
    for (const e of parseClaudeLine(o)) {
      events.push(e);
      if (e.kind === 'user' && !firstPrompt) firstPrompt = e.text.slice(0, 200);
    }
  }

  const timestamps = events.map((e) => e.ts).filter(Boolean).sort();
  if (cwd) cwd = reduceCwd(cwd, cwdsSeen);
  return {
    session: {
      id: sessionId,
      source: 'claude-code',
      file_path: file,
      cwd,
      started_at: timestamps[0] ?? null,
      ended_at: timestamps[timestamps.length - 1] ?? null,
      first_prompt: firstPrompt,
      context_tokens: contextTokens,
      skipped,
    },
    events,
  };
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  }
  return content == null ? '' : String(content);
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return null; }
}
