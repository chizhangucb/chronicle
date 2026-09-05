// Per-slice file-state freshness for hub adapter reads (CHI-323 part 1.4, D1).
//
// WHY NOT cache.ts: server/cache.ts bumps its generation counter ONLY on
// Chronicle DB writes. Adapter slices read hub FILES, which never touch the DB,
// so a `cached(url)` slice would freeze for the whole process lifetime (days).
// Each slice therefore tracks its OWN freshness signature over the files it
// reads, and recomputes only when that signature changes.
//
// Light slices (records, modules, roster, egress, safety) compute a cheap
// signature (max-mtime over a handful of files) on every request.
//
// The heavy slice (codegraphs over every built graph.json) must NOT stat-walk
// the corpus per request. Their
// freshness CHECK is TTL-gated (freshSlice ttlMs): inside the TTL window the
// cached value is returned without touching the filesystem; past it, the
// signature is recomputed and the value rebuilt only if files actually changed.
// Their built value is also mirrored to ~/.chronicle/hub-cache/<slice>.json so
// it survives a process restart; those writes are temp-file + rename (the
// gate's atomic pattern) so a concurrent recompute can't tear a read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = process.env.CHRONICLE_DATA_DIR || path.join(os.homedir(), '.chronicle');

/** Generic noise dirs pruned from every hub tree walk (never knowledge, can be
 * huge). Confidential trees are pruned via a caller-supplied set (CHI-390): the
 * SPECIFIC confidential names are never hardcoded in this public source. */
export const NOISE_DIRS = new Set(['node_modules', '.git']);

interface FreshEntry<T> {
  sig: string;
  value: T;
  checkedAt: number; // ms; last time the signature was (re)computed
}

interface FreshState {
  entries: Map<string, FreshEntry<unknown>>;
}

declare global {
  // eslint-disable-next-line no-var
  var __chronicleHubFresh: FreshState | undefined;
}

// State on globalThis so Vite SSR module reloads (dev) don't reset it mid-session
// — same pattern as server/cache.ts / server/autosync.ts.
const state: FreshState = (globalThis.__chronicleHubFresh ??= { entries: new Map() });

/** Max mtime (ms) over explicit paths; missing paths contribute 0. Cheap: for
 * the LIGHT slices that read a fixed handful of files. */
export function pathsMaxMtimeMs(paths: string[]): number {
  let max = 0;
  for (const p of paths) {
    try {
      const m = fs.lstatSync(p).mtimeMs; // lstat: never follow symlinks (floor)
      if (m > max) max = m;
    } catch {
      /* missing file contributes 0 */
    }
  }
  return max;
}

/** Recursive max mtime (ms) under `root`, lstat-only (symlinks are not
 * followed), pruning the generic noise dirs plus any caller-supplied prune set
 * (`extraPrune`, e.g. the hub's confidential segments). For heavy slices; call
 * behind a TTL gate, never per request. `filter` optionally limits which files
 * count (e.g. only *.md). */
export function treeMaxMtimeMs(root: string, filter?: (name: string) => boolean, extraPrune?: Set<string>): number {
  let max = 0;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue; // never follow symlinks (floor)
      if (e.isDirectory()) {
        if (NOISE_DIRS.has(e.name) || extraPrune?.has(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (filter && !filter(e.name)) continue;
        try {
          const m = fs.lstatSync(path.join(dir, e.name)).mtimeMs;
          if (m > max) max = m;
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root);
  return max;
}

/**
 * Return a slice's value, recomputing only when its file-state signature
 * changes. `computeSig` must be cheap for light slices. For heavy slices pass
 * `ttlMs`: inside the window the cached value is returned WITHOUT calling
 * `computeSig` (no stat-walk); past it the signature is checked and `compute`
 * runs only on an actual change.
 */
export function freshSlice<T>(
  key: string,
  computeSig: () => string,
  compute: () => T,
  opts: { ttlMs?: number } = {},
): T {
  const now = Date.now();
  const prev = state.entries.get(key) as FreshEntry<T> | undefined;

  if (prev && opts.ttlMs && now - prev.checkedAt < opts.ttlMs) {
    return prev.value; // TTL gate: skip the freshness check entirely
  }

  const sig = computeSig();
  if (prev && prev.sig === sig) {
    prev.checkedAt = now; // unchanged: keep value, reset the TTL window
    return prev.value;
  }

  const value = compute();
  state.entries.set(key, { sig, value, checkedAt: now });
  return value;
}

/**
 * Async variant for the HEAVY slice (codegraphs over every built graph.json).
 * Same TTL gate as freshSlice,
 * but `compute` is async and the resolved value is mirrored to the on-disk
 * hub-cache so it survives a process restart. Inside the TTL window it returns
 * the cached value WITHOUT the stat-walk; past it, the signature is recomputed
 * and `compute` runs only on an actual change. On a cold start it warms from the
 * on-disk cache (still verified against the current signature).
 */
export async function freshSliceAsync<T>(
  key: string,
  computeSig: () => string,
  compute: () => Promise<T>,
  opts: { ttlMs?: number } = {},
): Promise<T> {
  const now = Date.now();
  let prev = state.entries.get(key) as FreshEntry<T> | undefined;

  if (prev && opts.ttlMs && now - prev.checkedAt < opts.ttlMs) return prev.value;

  const sig = computeSig();
  if (!prev) {
    // Cold start: warm from disk if the on-disk signature still matches.
    const disk = readHubCache<T>(key);
    if (disk && disk.sig === sig) {
      prev = { sig: disk.sig, value: disk.value, checkedAt: now };
      state.entries.set(key, prev);
      return prev.value;
    }
  }
  if (prev && prev.sig === sig) {
    prev.checkedAt = now;
    return prev.value;
  }

  const value = await compute();
  state.entries.set(key, { sig, value, checkedAt: now });
  try { writeHubCache(key, sig, value); } catch { /* cache write is best-effort */ }
  return value;
}

/** Drop a slice's memoized entry (test seam; also lets a write path force the
 * next read to recompute). */
export function invalidateSlice(key: string): void {
  state.entries.delete(key);
}

// ---- On-disk cache for heavy slices (survives process restart) ----

export function hubCacheDir(): string {
  return path.join(DATA_DIR, 'hub-cache');
}

interface DiskCache<T> {
  sig: string;
  value: T;
}

/** Read a heavy slice's on-disk cache, or null if absent/unreadable. */
export function readHubCache<T>(slice: string): DiskCache<T> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(hubCacheDir(), `${slice}.json`), 'utf8')) as DiskCache<T>;
  } catch {
    return null;
  }
}

/** Write a heavy slice's on-disk cache atomically (temp file + rename), so a
 * concurrent read never sees a half-written file. */
export function writeHubCache<T>(slice: string, sig: string, value: T): void {
  const dir = hubCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, `${slice}.json`);
  const tmp = path.join(dir, `.${slice}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ sig, value } satisfies DiskCache<T>));
  fs.renameSync(tmp, final); // atomic within the same dir
}
