import fs from 'node:fs';
import type { Response } from 'express';
import { getDb } from './db.ts';
import type { SessionRow } from '../shared/rows.ts';
import type { LiveWatcher } from '../shared/results.ts';
import { sourceById } from './parsers/registry.ts';
import { openWatchers, watcherFor, type SessionWatcher } from './liveWatchers.ts';

// Session Live Streaming (FR-LS): which sessions are live, and the SSE stream
// on one of them. The watchers themselves live in ./liveWatchers.ts.

const LIVE_WINDOW_MS = 5 * 60 * 1000;

// Minimal shape callers pass in — real callers select subsets of the `sessions`
// table columns (file_path/ended_at at least, id always).
interface LiveSessionLike {
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

export function attachLiveStream(sessionId: string, res: Response): boolean {
  const session = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!session || !fs.existsSync(session.file_path)) return false;
  // No parser, no stream: a source Chronicle cannot read has nothing to tail
  // and nothing to re-parse.
  const source = sourceById(session.source);
  if (!source) return false;
  // The watcher outlives this request: a second tab on the same session joins
  // the one already open, and the last client to leave is what stops it.
  const watcher: SessionWatcher = watcherFor(sessionId, session, source);
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
  return [...openWatchers().values()].map((w) => w.status());
}

// Session ids with an active live watcher (an open SSE stream) right now. Used
// by /api/activity to mark a session "live" even if its stored ended_at is
// older than the 5-min window — a client is actively streaming it.
export function liveWatcherSessionIds(): Set<string> {
  return new Set(openWatchers().keys());
}
