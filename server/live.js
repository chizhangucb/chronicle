import fs from 'node:fs';
import { db } from './db.js';
import { parseClaudeLine } from './parsers/claudeCode.js';
import { parseOpencodeSessions } from './parsers/opencode.js';
import { parseCursorWorkspace, parseAgentTranscriptJsonl } from './parsers/cursor.js';
import path from 'node:path';

// Session Live Streaming (FR-LS): incremental JSONL tail → SSE.
// Watch state survives Vite SSR reloads via globalThis.

const live = globalThis.__chronicleLive ??= { watchers: new Map() }; // sessionId -> Watcher

const LIVE_WINDOW_MS = 5 * 60 * 1000;

function fileRecentlyWritten(filePath) {
  try {
    let mtime = fs.statSync(filePath).mtimeMs;
    const wal = filePath + '-wal';
    if (fs.existsSync(wal)) mtime = Math.max(mtime, fs.statSync(wal).mtimeMs);
    return Date.now() - mtime < LIVE_WINDOW_MS;
  } catch { return false; }
}

function sessionRecentlyActive(session) {
  if (!session?.ended_at) return true;
  const ended = new Date(session.ended_at).getTime();
  return Number.isFinite(ended) && Date.now() - ended < LIVE_WINDOW_MS;
}

// Mark at most one live session per shared log file (e.g. workspace/global SQLite).
export function liveCandidatesForSessions(sessions) {
  const winners = new Set();
  const byFile = new Map();
  for (const s of sessions) {
    if (!s?.file_path || !fileRecentlyWritten(s.file_path)) continue;
    const group = byFile.get(s.file_path) || [];
    group.push(s);
    byFile.set(s.file_path, group);
  }
  for (const group of byFile.values()) {
    const eligible = group.filter(sessionRecentlyActive);
    if (!eligible.length) continue;
    if (group[0].file_path.endsWith('.jsonl')) {
      for (const s of eligible) winners.add(s.id);
      continue;
    }
    const best = eligible.sort((a, b) => new Date(b.ended_at || 0) - new Date(a.ended_at || 0))[0];
    winners.add(best.id);
  }
  return winners;
}

export function isLiveCandidate(filePath, session = null, peers = null) {
  if (!filePath) return false;
  if (!fileRecentlyWritten(filePath)) return false;
  if (session && peers?.length) return liveCandidatesForSessions(peers).has(session.id);
  if (session) return sessionRecentlyActive(session);
  return true;
}

class Watcher {
  constructor(sessionId, filePath, source) {
    this.sessionId = sessionId;
    this.filePath = filePath;
    this.source = source;
    this.clients = new Set();       // SSE res objects
    this.offset = fs.statSync(filePath).size;  // start at EOF: only new content
    this.partial = '';
    this.seq = 1_000_000;           // live events get high seqs (after stored ones)
    this.poll = setInterval(() => this.check(), 700);  // FR-LS-9: cheap stat + incremental read
    this.idleSince = Date.now();
  }

  check() {
    let size;
    try { size = fs.statSync(this.filePath).size; } catch { return this.close('file gone'); }
    if (size < this.offset) this.offset = 0; // truncated/rotated — re-read
    if (size === this.offset) {
      // Idle detection (FR-LS-5): slow down after 2 min of silence
      if (Date.now() - this.idleSince > 120000 && this.pollMs !== 3000) this.setPollInterval(3000);
      return;
    }
    this.idleSince = Date.now();
    this.setPollInterval(700);
    const stream = fs.createReadStream(this.filePath, { start: this.offset, end: size - 1, encoding: 'utf8' });
    let chunk = '';
    stream.on('data', (d) => { chunk += d; });
    stream.on('end', () => {
      this.offset = size;
      const text = this.partial + chunk;
      const lines = text.split('\n');
      this.partial = lines.pop() ?? ''; // last element may be a partial line
      const events = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = this.source === 'claude-code' ? parseClaudeLine(JSON.parse(line)) : genericLine(JSON.parse(line));
          for (const e of parsed) events.push({ ...e, seq: this.seq++ });
        } catch { /* FR-LS-6: skip unparseable, continue */ }
      }
      if (events.length) this.broadcast({ type: 'messages', events });
    });
    stream.on('error', () => {});
  }

  setPollInterval(ms) {
    if (this.pollMs === ms) return;
    this.pollMs = ms;
    clearInterval(this.poll);
    this.poll = setInterval(() => this.check(), ms);
  }

  broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) {
      try { res.write(data); } catch { this.clients.delete(res); }
    }
  }

  addClient(res) {
    this.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'status', status: 'live', watching: this.filePath })}\n\n`);
  }

  removeClient(res) {
    this.clients.delete(res);
    if (!this.clients.size) this.close('no clients'); // FR-LS-7 auto-stop
  }

  close(reason) {
    clearInterval(this.poll);
    this.broadcast({ type: 'status', status: 'stopped', reason });
    for (const res of this.clients) { try { res.end(); } catch {} }
    this.clients.clear();
    live.watchers.delete(this.sessionId);
  }
}

// SQLite-backed sources (Cursor, OpenCode): read-only periodic re-parse with
// diff-against-last-state (FR-LS-1). The parser layer already snapshots the DB
// to temp before reading, so the foreign database is never touched.
class SqlitePollWatcher {
  constructor(sessionId, session) {
    this.sessionId = sessionId;
    this.session = session;
    this.clients = new Set();
    this.lastCount = countStored(sessionId);
    this.lastMtime = 0;
    this.seq = 1_000_000;
    this.pollMs = 2000;
    this.poll = setInterval(() => this.check(), this.pollMs);
    this.idleSince = Date.now();
  }

  fetchEvents() {
    if (this.session.source === 'opencode') {
      const dir = db.prepare('SELECT path FROM projects WHERE id = ?').get(this.session.project_id)?.path;
      const all = parseOpencodeSessions(this.session.file_path, dir);
      return all.find((s) => s.session.id === this.sessionId)?.events ?? [];
    }
    if (this.session.source === 'cursor') {
      if (this.session.file_path.endsWith('.jsonl')) {
        return parseAgentTranscriptJsonl(this.session.file_path);
      }
      const all = parseCursorWorkspace(path.dirname(this.session.file_path), undefined, this.session.cwd || null);
      return all.find((s) => s.session.id === this.sessionId)?.events ?? [];
    }
    return [];
  }

  check() {
    let mtime = 0;
    try {
      mtime = fs.statSync(this.session.file_path).mtimeMs;
      // WAL writes may not touch the main db file
      const wal = this.session.file_path + '-wal';
      if (fs.existsSync(wal)) mtime = Math.max(mtime, fs.statSync(wal).mtimeMs);
    } catch { return this.close('file gone'); }
    if (mtime === this.lastMtime) {
      if (Date.now() - this.idleSince > 120000 && this.pollMs !== 6000) this.setPollInterval(6000);
      return;
    }
    this.lastMtime = mtime;
    this.idleSince = Date.now();
    this.setPollInterval(2000);
    try {
      const events = this.fetchEvents();
      if (events.length > this.lastCount) {
        const fresh = events.slice(this.lastCount).map((e) => ({ ...e, seq: this.seq++ }));
        this.lastCount = events.length;
        this.broadcast({ type: 'messages', events: fresh });
      }
    } catch { /* transient parse failure — retry next poll (FR-LS-6) */ }
  }

  setPollInterval(ms) {
    if (this.pollMs === ms) return;
    this.pollMs = ms;
    clearInterval(this.poll);
    this.poll = setInterval(() => this.check(), ms);
  }

  broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) {
      try { res.write(data); } catch { this.clients.delete(res); }
    }
  }

  addClient(res) {
    this.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'status', status: 'live', watching: this.session.file_path, mode: 'poll' })}\n\n`);
  }

  removeClient(res) {
    this.clients.delete(res);
    if (!this.clients.size) this.close('no clients');
  }

  close(reason) {
    clearInterval(this.poll);
    this.broadcast({ type: 'status', status: 'stopped', reason });
    for (const res of this.clients) { try { res.end(); } catch {} }
    this.clients.clear();
    live.watchers.delete(this.sessionId);
  }
}

function countStored(sessionId) {
  return db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId)?.n ?? 0;
}

// Codex live lines share the response_item shape
function genericLine(o) {
  const p = o.payload || o;
  const ts = o.timestamp || null;
  if (p.type === 'message' && p.role) {
    const text = (Array.isArray(p.content) ? p.content.map((c) => c.text || '').join('') : p.content) || '';
    return text ? [{ ts, kind: p.role === 'user' ? 'user' : 'assistant', text }] : [];
  }
  return [];
}

export function attachLiveStream(sessionId, res) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session || !fs.existsSync(session.file_path)) return false;
  let watcher = live.watchers.get(sessionId);
  if (!watcher) {
    watcher = session.source === 'cursor' || session.source === 'opencode'
      ? new SqlitePollWatcher(sessionId, session)
      : new Watcher(sessionId, session.file_path, session.source);
    live.watchers.set(sessionId, watcher);
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  watcher.addClient(res);
  res.on('close', () => watcher.removeClient(res));
  return true;
}

export function liveStatus() {
  return [...live.watchers.values()].map((w) => ({
    sessionId: w.sessionId, file: w.filePath, clients: w.clients.size, offset: w.offset,
  }));
}
