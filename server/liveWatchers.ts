import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import { getDb } from './db.ts';
import type { SessionRow } from '../shared/rows.ts';
import type { LiveWatcher } from '../shared/results.ts';
import type { Source } from './parsers/source.ts';
import type { Event, ParseTarget } from '../shared/types.ts';

// Session Live Streaming (FR-LS): what every live watcher carries, in one
// place (#379). A watcher polls whatever its session is written to, turns what
// is new into events, and pushes them to the clients holding an SSE stream
// open on that session. Only the middle step differs between the two stores
// Chronicle reads: an append-only transcript is read forward from where the
// last poll stopped, a SQLite store is re-parsed and diffed. So that step is
// the one thing an adapter supplies, and the client set, the broadcast, the
// idle-poll bookkeeping and the close belong to the base below.
//
// Watch state survives Vite SSR reloads via globalThis.

interface LiveState {
  watchers: Map<string, SessionWatcher>;
}

declare global {
  // eslint-disable-next-line no-var
  var __chronicleLive: LiveState | undefined;
}

const live: LiveState = globalThis.__chronicleLive ??= { watchers: new Map() };

// Live events get high seqs, so they sort after every stored message.
const FIRST_LIVE_SEQ = 1_000_000;

// FR-LS-5: a session that has said nothing for this long is polled slowly
// until it speaks again.
const IDLE_AFTER_MS = 120000;

// How often a watcher looks for new events: the fast cadence while the session
// is writing, the slow one once it has gone quiet.
interface PollCadence {
  activeMs: number;
  idleMs: number;
}

// What a joining client is told it is watching: the store being read, and how
// it is being read where that is not line by line.
interface OpeningStatus {
  watching: string;
  mode?: 'poll';
}

// The scaffolding both live watchers carry. A subclass says where its events
// come from; everything a client can observe (the opening status, the event
// batches, the auto-stop, the step down to the idle cadence) happens here.
//
// SessionWatcher is exported as the seam test/live-watchers.test.mjs drives
// the base through: a scripted adapter is how the base's own behaviour is
// asserted without a file or a store underneath it.
export abstract class SessionWatcher {
  readonly sessionId: string;
  readonly clients = new Set<Response>();          // SSE res objects
  private readonly cadence: PollCadence;
  // What the last poll saw of the session's store: its size for a transcript,
  // its write time for a SQLite store. Equal means nothing to fetch.
  private revisionSeen: number | null;
  private poll: NodeJS.Timeout;
  private pollMs: number;
  private idleSince: number;
  private seq = FIRST_LIVE_SEQ;
  // A fetch can outlast the poll interval (a store re-parse does); a second
  // one on top of it would diff against the same state and broadcast the same
  // events twice. The transcript tail is held to the same rule now that both
  // watchers share this loop, and a skipped poll costs it nothing: the offset
  // it would have read from has not moved.
  private fetching = false;

  constructor(sessionId: string, cadence: PollCadence, revisionSeen: number | null) {
    this.sessionId = sessionId;
    this.cadence = cadence;
    this.revisionSeen = revisionSeen;
    this.pollMs = cadence.activeMs;
    this.poll = setInterval(() => { this.check().catch(() => {}); }, cadence.activeMs);
    this.idleSince = Date.now();
    live.watchers.set(sessionId, this);
  }

  // What the store looks like right now, cheaply: a number that changes when
  // the session is written to, or null when it cannot be read at all.
  protected abstract revision(): number | null;

  // The events added since the last fetch, given the revision that prompted
  // it. Yields none rather than throwing for something it cannot read, so one
  // bad line or a half-written store never stops the stream (FR-LS-6).
  protected abstract fetchNewEvents(revision: number): Promise<Event[]>;

  // What this watcher tells a joining client it is watching.
  protected abstract opening(): OpeningStatus;

  // FR-LS-9: a cheap read first, and the work only when it says there is some.
  async check(): Promise<void> {
    if (this.fetching) return;
    const revision = this.revision();
    if (revision === null) return this.close('file gone');
    if (revision === this.revisionSeen) {
      if (Date.now() - this.idleSince > IDLE_AFTER_MS) this.setPollInterval(this.cadence.idleMs);
      return;
    }
    const seenBefore = this.revisionSeen;
    this.revisionSeen = revision;
    this.idleSince = Date.now();
    this.setPollInterval(this.cadence.activeMs);
    this.fetching = true;
    try {
      const events = await this.fetchNewEvents(revision);
      if (events.length) {
        this.broadcast({ type: 'messages', events: events.map((e) => ({ ...e, seq: this.seq++ })) });
      }
    } catch {
      // A fetch that failed left the adapter where it was, so un-see this
      // revision: the next poll reads it again rather than mistaking the
      // store for quiet until the session is written to next (FR-LS-6).
      this.revisionSeen = seenBefore;
    } finally {
      this.fetching = false;
    }
  }

  private setPollInterval(ms: number): void {
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
    res.write(`data: ${JSON.stringify({ type: 'status', status: 'live', ...this.opening() })}\n\n`);
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

  // What /api/live/status reports. A watcher that reads forward through one
  // session's file adds that file and how far into it it has got; a store poll
  // has neither, because the store it re-parses is shared by many sessions.
  status(): LiveWatcher {
    return { sessionId: this.sessionId, file: undefined, clients: this.clients.size, offset: undefined };
  }
}

// An append-only transcript (a source that declares `tail`): read what was
// added since the last poll and hand each new line to its source.
class TailWatcher extends SessionWatcher {
  private readonly filePath: string;
  private readonly source: Source;
  private offset: number;
  private partial = '';

  constructor(sessionId: string, filePath: string, source: Source) {
    const size = fs.statSync(filePath).size;
    super(sessionId, { activeMs: 700, idleMs: 3000 }, size);
    this.filePath = filePath;
    this.offset = size;  // start at EOF: only new content
    this.source = source;
  }

  protected revision(): number | null {
    try { return fs.statSync(this.filePath).size; } catch { return null; }
  }

  protected async fetchNewEvents(size: number): Promise<Event[]> {
    if (size < this.offset) this.offset = 0; // truncated/rotated, so re-read
    const start = this.offset;
    if (size === start) return [];
    const text = this.partial + await readRange(this.filePath, start, size - 1);
    this.offset = size;
    const lines = text.split('\n');
    this.partial = lines.pop() ?? ''; // last element may be a partial line
    const events: Event[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      // FR-LS-6: `tail` yields no events for a line it cannot read, rather
      // than throwing, so one bad line never stops the stream. Non-null: this
      // watcher is only built for a source that declares it.
      for (const e of (this.source.tail as (l: string) => Event[])(line)) events.push(e);
    }
    return events;
  }

  protected opening(): OpeningStatus {
    return { watching: this.filePath };
  }

  status(): LiveWatcher {
    return { ...super.status(), file: this.filePath, offset: this.offset };
  }
}

// SQLite-backed sources (Cursor, OpenCode): read-only periodic re-parse with
// diff-against-last-state (FR-LS-1). The parser layer already snapshots the DB
// to temp before reading, so the foreign database is never touched.
class StorePollWatcher extends SessionWatcher {
  private readonly session: SessionRow;
  private readonly source: Source;
  // The parse targets this session can be read out of, resolved once from the
  // source's own scan: a store holds many sessions, so live re-parses the
  // target and picks its own session back out by id.
  private readonly targets: ParseTarget[];
  private lastCount: number;

  constructor(sessionId: string, session: SessionRow, source: Source) {
    // Both reads happen before super(), which is what registers the watcher
    // and starts its timer: a scan or a query that throws leaves no half-built
    // watcher behind in the open set.
    const targets = storeTargets(source, session);
    const stored = countStored(sessionId);
    // Nothing seen yet, so the first poll re-parses and diffs against what is
    // already stored rather than waiting for the next write.
    super(sessionId, { activeMs: 2000, idleMs: 6000 }, null);
    this.session = session;
    this.source = source;
    this.targets = targets;
    this.lastCount = stored;
  }

  // The source knows what counts as a write to its store (a `-wal` sidecar is
  // one; the main file may never be touched).
  protected revision(): number | null {
    return this.source.mtime(this.session.file_path);
  }

  protected async fetchNewEvents(): Promise<Event[]> {
    for (const target of this.targets) {
      try {
        const parsed = await this.source.parse(target);
        const hit = parsed.find((p) => p.session.id === this.sessionId);
        if (!hit) continue;
        if (hit.events.length <= this.lastCount) return [];
        const fresh = hit.events.slice(this.lastCount);
        this.lastCount = hit.events.length;
        return fresh;
      } catch { /* not a target this source can read — try the next spelling */ }
    }
    return [];
  }

  protected opening(): OpeningStatus {
    return { watching: this.session.file_path, mode: 'poll' };
  }
}

// One range of a file, as text. Rejects rather than resolving short, so a read
// that failed half way is retried on the next poll instead of being handed on
// as if it were the whole appended chunk.
function readRange(filePath: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start, end, encoding: 'utf8' });
    let chunk = '';
    stream.on('data', (d) => { chunk += d; });
    stream.on('end', () => resolve(chunk));
    stream.on('error', reject);
  });
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

// The watcher for this session, opening one if nobody has yet. Which adapter
// is the source's own shape, not its name: `tail` exists exactly on an
// append-only transcript, so a source that declares it is streamed line by
// line and one that does not is re-parsed from its store.
export function watcherFor(sessionId: string, session: SessionRow, source: Source): SessionWatcher {
  const open = live.watchers.get(sessionId);
  if (open) return open;
  return source.tail
    ? new TailWatcher(sessionId, session.file_path, source)
    : new StorePollWatcher(sessionId, session, source);
}

// The watchers with an SSE stream open right now, by session id.
export function openWatchers(): Map<string, SessionWatcher> {
  return live.watchers;
}
