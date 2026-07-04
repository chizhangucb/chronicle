import fs from 'node:fs';
import { db } from './db.js';
import { parseClaudeLine } from './parsers/claudeCode.js';

// Session Live Streaming (FR-LS): incremental JSONL tail → SSE.
// Watch state survives Vite SSR reloads via globalThis.

const live = globalThis.__chronicleLive ??= { watchers: new Map() }; // sessionId -> Watcher

const LIVE_WINDOW_MS = 5 * 60 * 1000;

export function isLiveCandidate(filePath) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs < LIVE_WINDOW_MS;
  } catch { return false; }
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
  if (!session) return false;
  if (!fs.existsSync(session.file_path) || session.source === 'cursor' || session.source === 'opencode') {
    // SQLite-backed sources need polling re-parse — deferred; JSONL sources only for now
    return false;
  }
  let watcher = live.watchers.get(sessionId);
  if (!watcher) {
    watcher = new Watcher(sessionId, session.file_path, session.source);
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
