import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { getDb } from './db.ts';
import type { SessionRow } from '../shared/rows.ts';
import type { LiveWatcher } from '../shared/results.ts';
import { sourceById } from './parsers/registry.ts';
import type { Source } from './parsers/source.ts';
import type { Event, ParseTarget } from '../shared/types.ts';

// Session Live Streaming (FR-LS): incremental JSONL tail → SSE.
// Watch state survives Vite SSR reloads via globalThis.

type AnyWatcher = Watcher | SqlitePollWatcher;

interface LiveState {
  watchers: Map<string, AnyWatcher>;
}

declare global {
  // eslint-disable-next-line no-var
  var __chronicleLive: LiveState | undefined;
}

const live: LiveState = globalThis.__chronicleLive ??= { watchers: new Map() };

const LIVE_WINDOW_MS = 5 * 60 * 1000;

// Minimal shape callers pass in — real callers select subsets of the `sessions`
// table columns (file_path/ended_at at least, id always).
export interface LiveSessionLike {
  id: string;
  file_path?: string | null;
  ended_at?: string | null;
}

function fileRecentlyWritten(filePath: string): boolean {
  try {
    let mtime = fs.statSync(filePath).mtimeMs;
    const wal = filePath + '-wal';
    if (fs.existsSync(wal)) mtime = Math.max(mtime, fs.statSync(wal).mtimeMs);
    return Date.now() - mtime < LIVE_WINDOW_MS;
  } catch { return false; }
}

function sessionRecentlyActive(session: LiveSessionLike | null | undefined): boolean {
  if (!session?.ended_at) return true;
  const ended = new Date(session.ended_at).getTime();
  return Number.isFinite(ended) && Date.now() - ended < LIVE_WINDOW_MS;
}

// Mark at most one live session per shared log file (e.g. workspace/global SQLite).
export function liveCandidatesForSessions(sessions: LiveSessionLike[]): Set<string> {
  const winners = new Set<string>();
  const byFile = new Map<string, LiveSessionLike[]>();
  for (const s of sessions) {
    if (!s?.file_path || !fileRecentlyWritten(s.file_path)) continue;
    const group = byFile.get(s.file_path) || [];
    group.push(s);
    byFile.set(s.file_path, group);
  }
  for (const group of byFile.values()) {
    const eligible = group.filter(sessionRecentlyActive);
    if (!eligible.length) continue;
    if ((group[0].file_path as string).endsWith('.jsonl')) {
      for (const s of eligible) winners.add(s.id);
      continue;
    }
    const best = eligible.sort((a, b) => new Date(b.ended_at || 0).getTime() - new Date(a.ended_at || 0).getTime())[0];
    winners.add(best.id);
  }
  return winners;
}

export function isLiveCandidate(
  filePath: string | null | undefined,
  session: LiveSessionLike | null = null,
  peers: LiveSessionLike[] | null = null,
): boolean {
  if (!filePath) return false;
  if (!fileRecentlyWritten(filePath)) return false;
  if (session && peers?.length) return liveCandidatesForSessions(peers).has(session.id);
  if (session) return sessionRecentlyActive(session);
  return true;
}

// An append-only transcript (a source that declares `tail`): read what was
// added since the last poll and hand each new line to its source.
class Watcher {
  sessionId: string;
  filePath: string;
  source: Source;
  clients: Set<Response>;
  offset: number;
  partial: string;
  seq: number;
  poll: NodeJS.Timeout;
  idleSince: number;
  pollMs?: number;

  constructor(sessionId: string, filePath: string, source: Source) {
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

  check(): void {
    let size: number;
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
      const events: Event[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        // FR-LS-6: `tail` yields no events for a line it cannot read, rather
        // than throwing, so one bad line never stops the stream. Non-null: this
        // watcher is only built for a source that declares it.
        for (const e of (this.source.tail as (l: string) => Event[])(line)) events.push({ ...e, seq: this.seq++ });
      }
      if (events.length) this.broadcast({ type: 'messages', events });
    });
    stream.on('error', () => {});
  }

  setPollInterval(ms: number): void {
    if (this.pollMs === ms) return;
    this.pollMs = ms;
    clearInterval(this.poll);
    this.poll = setInterval(() => this.check(), ms);
  }

  broadcast(payload: unknown): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) {
      try { res.write(data); } catch { this.clients.delete(res); }
    }
  }

  addClient(res: Response): void {
    this.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'status', status: 'live', watching: this.filePath })}\n\n`);
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
    if (!this.clients.size) this.close('no clients'); // FR-LS-7 auto-stop
  }

  close(reason: string): void {
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
  sessionId: string;
  session: SessionRow;
  source: Source;
  // The parse targets this session can be read out of, resolved once from the
  // source's own scan: a store holds many sessions, so live re-parses the
  // target and picks its own session back out by id.
  targets: ParseTarget[];
  clients: Set<Response>;
  lastCount: number;
  lastMtime: number;
  // A store re-parse is async and can outlast the poll interval; a second one
  // on top of it would race `lastCount` and broadcast the same events twice.
  checking: boolean;
  seq: number;
  pollMs: number;
  poll: NodeJS.Timeout;
  idleSince: number;
  // Not set on this class (only Watcher sets them) — declared here so
  // liveStatus() can read them uniformly across both watcher types, exactly
  // as the untyped JS did (accessing an absent property yields undefined).
  filePath?: string;
  offset?: number;

  constructor(sessionId: string, session: SessionRow, source: Source) {
    this.sessionId = sessionId;
    this.session = session;
    this.source = source;
    this.targets = storeTargets(source, session);
    this.clients = new Set();
    this.lastCount = countStored(sessionId);
    this.lastMtime = 0;
    this.checking = false;
    this.seq = 1_000_000;
    this.pollMs = 2000;
    this.poll = setInterval(() => { this.check().catch(() => {}); }, this.pollMs);
    this.idleSince = Date.now();
  }

  async fetchEvents(): Promise<Event[]> {
    for (const target of this.targets) {
      try {
        const parsed = await this.source.parse(target);
        const hit = parsed.find((p) => p.session.id === this.sessionId);
        if (hit) return hit.events;
      } catch { /* not a target this source can read — try the next spelling */ }
    }
    return [];
  }

  async check(): Promise<void> {
    if (this.checking) return;
    // The source knows what counts as a write to its store (a `-wal` sidecar
    // is one; the main file may never be touched).
    const mtime = this.source.mtime(this.session.file_path);
    if (mtime === null) return this.close('file gone');
    if (mtime === this.lastMtime) {
      if (Date.now() - this.idleSince > 120000 && this.pollMs !== 6000) this.setPollInterval(6000);
      return;
    }
    this.lastMtime = mtime;
    this.idleSince = Date.now();
    this.setPollInterval(2000);
    this.checking = true;
    try {
      const events = await this.fetchEvents();
      if (events.length > this.lastCount) {
        const fresh = events.slice(this.lastCount).map((e) => ({ ...e, seq: this.seq++ }));
        this.lastCount = events.length;
        this.broadcast({ type: 'messages', events: fresh });
      }
    } catch { /* transient parse failure — retry next poll (FR-LS-6) */ } finally {
      this.checking = false;
    }
  }

  setPollInterval(ms: number): void {
    if (this.pollMs === ms) return;
    this.pollMs = ms;
    clearInterval(this.poll);
    this.poll = setInterval(() => { this.check().catch(() => {}); }, ms);
  }

  broadcast(payload: unknown): void {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.clients) {
      try { res.write(data); } catch { this.clients.delete(res); }
    }
  }

  addClient(res: Response): void {
    this.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'status', status: 'live', watching: this.session.file_path, mode: 'poll' })}\n\n`);
  }

  removeClient(res: Response): void {
    this.clients.delete(res);
    if (!this.clients.size) this.close('no clients');
  }

  close(reason: string): void {
    clearInterval(this.poll);
    this.broadcast({ type: 'status', status: 'stopped', reason });
    for (const res of this.clients) { try { res.end(); } catch {} }
    this.clients.clear();
    live.watchers.delete(this.sessionId);
  }
}

function countStored(sessionId: string): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number } | undefined)?.n ?? 0;
}

// Where a stored session can be re-read from, in the order worth trying: the
// scanned projects sitting on this session's project path, then the store the
// session itself names. The second is what covers a session imported from a
// store the default scan does not walk (a hand-picked directory, a fixture);
// a source spells that store either as the file (`opencode.db`) or as the
// directory holding it (a Cursor workspace), so both spellings are offered and
// the one the source cannot read simply parses to nothing.
//
// Resolved once per watcher — a scan walks the source's root, which is too
// much to redo every poll.
function storeTargets(source: Source, session: SessionRow): ParseTarget[] {
  const projectPath = (getDb().prepare('SELECT path FROM projects WHERE id = ?').get(session.project_id) as { path: string } | undefined)?.path;
  const scanned = projectPath ? source.scan().filter((item) => item.physicalPath === projectPath) : [];
  const own = { directory: projectPath, physicalPath: projectPath ?? null };
  return [...scanned, { ...own, logDir: session.file_path }, { ...own, logDir: path.dirname(session.file_path) }];
}

export function attachLiveStream(sessionId: string, res: Response): boolean {
  const session = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!session || !fs.existsSync(session.file_path)) return false;
  // No parser, no stream: a source Chronicle cannot read has nothing to tail
  // and nothing to re-parse.
  const source = sourceById(session.source);
  if (!source) return false;
  let watcher = live.watchers.get(sessionId);
  if (!watcher) {
    // Which watcher is the source's own shape, not its name: `tail` exists
    // exactly on an append-only transcript, so a source that declares it is
    // streamed line by line and one that does not is re-parsed from its store.
    watcher = source.tail
      ? new Watcher(sessionId, session.file_path, source)
      : new SqlitePollWatcher(sessionId, session, source);
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

export function liveStatus(): LiveWatcher[] {
  return [...live.watchers.values()].map((w) => ({
    sessionId: w.sessionId, file: w.filePath, clients: w.clients.size, offset: w.offset,
  }));
}

// Session ids with an active live watcher (an open SSE stream) right now. Used
// by /api/activity to mark a session "live" even if its stored ended_at is
// older than the 5-min window — a client is actively streaming it.
export function liveWatcherSessionIds(): Set<string> {
  return new Set(live.watchers.keys());
}
