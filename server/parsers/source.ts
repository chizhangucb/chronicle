// One `Source` per coding tool (#308). Four parsers used to expose four shapes,
// so import, sync and live each branched on the source string; this is the one
// interface they all implement, beside their existing entry points.
//
// The four differ in where their records live — Claude Code and Codex write one
// JSONL transcript per session, Cursor and OpenCode keep many sessions in one
// SQLite store — so the interface names the units they share (a root to scan, a
// target to parse, a path whose write time says "re-parse me") and leaves the
// per-store live shape optional: `tail` exists only on an append-only
// transcript.
import fs from 'node:fs';
import type { Event, ParseResult, ParseTarget, ScannedProject, SourceId } from '../../shared/types.ts';

export interface Source {
  // Which coding tool this source reads. Matches `sessions.source`.
  id: SourceId;

  // Where this source's records live on this machine when the operator has not
  // named a directory: a log root for a per-file source, the store's own path
  // for a SQLite-backed one. A function, not a constant, because Cursor's
  // location is resolved per platform (and per test env var) at call time.
  defaultRoot(): string;

  // List what is importable under `root` (default: `defaultRoot()`), the
  // pre-import listing the import wizard shows. Never parses a transcript.
  scan(root?: string): ScannedProject[];

  // Turn one scanned project — or any narrower target the caller builds from
  // one — into its sessions and their messages. A `ScannedProject` is itself a
  // valid target, so `parse(scan()[0])` is the whole import path.
  parse(target: ParseTarget): Promise<ParseResult[]>;

  // The newest write time (ms) of one importable unit: the transcript file for
  // a per-file source, the store for a shared-store one. Null when the path
  // cannot be read at all, so a caller can tell "unknown" from "unchanged".
  mtime(unit: string): number | null;

  // Optional: one newly appended transcript line to its events, for a source
  // whose store is an append-only file. Absent on a SQLite-backed source, where
  // there is no line to append and live re-reads the store instead. An
  // unparseable line yields no events rather than throwing.
  tail?(line: string): Event[];
}

// The newest mtime (ms) across a set of paths, ignoring the ones that are not
// there. Null when none of them can be stat'd. SQLite stores are read with
// their `-wal` sidecar, where a write can land without touching the main file.
export function newestMtimeMs(...paths: string[]): number | null {
  let newest: number | null = null;
  for (const p of paths) {
    try {
      const m = fs.statSync(p).mtime.getTime();
      if (newest === null || m > newest) newest = m;
    } catch { /* not there — not a write time */ }
  }
  return newest;
}

// The importable files one scanned project lists: a per-file source (one
// transcript per session) names them, a store-backed one names none. The
// difference is in the scan's own shape, so a caller can re-parse per file
// where that is possible and per store where it is not, without naming a
// source.
export function importableFiles(item: ScannedProject): string[] {
  if (item.files?.length) return item.files;
  return (item.sessions ?? []).map((s) => s.file).filter((f): f is string => !!f);
}
