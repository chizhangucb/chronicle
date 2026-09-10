// The one cache every server-side memoized value goes through: the heavy
// analytics routes (insights, explore, content, per-project analytics), the
// Insights engine's commit counts and fixed windows, and ask's claude-binary
// probe.
//
// An entry has exactly ONE staleness rule, chosen by whether the caller passes
// a TTL.
//
// GENERATION is the default, and it is what every value read out of the
// database uses. Each DB write path calls invalidateCache(), which bumps the
// counter, so an entry whose stored generation no longer matches the current
// one is a miss. Correctness comes from invalidation, not expiry.
//
// TTL is the opt-in, for a value whose input is NOT the database: a
// `git rev-list` count, a `which claude` probe. Nothing bumps the generation
// when that kind of answer changes, so expiry is the only thing that can
// bound the staleness, and generation-keying it on top would be pure loss:
// autosync re-imports a live session every few seconds, which would wipe a
// five-minute Git memo before it ever paid for itself.
//
// State lives on globalThis so Vite SSR module reloads (dev) don't reset it
// mid-session, the same pattern as server/live.ts / server/autosync.ts.
type CacheEntry<T> =
  | { rule: 'generation'; gen: number; value: T }
  | { rule: 'ttl'; expiresAt: number; value: T };

interface CacheState {
  gen: number;
  map: Map<string, CacheEntry<unknown>>;
}

declare global {
  // eslint-disable-next-line no-var
  var __chronicleCache: CacheState | undefined;
}

const state: CacheState = (globalThis.__chronicleCache ??= { gen: 0, map: new Map() });

function isFresh(entry: CacheEntry<unknown>, now: number): boolean {
  return entry.rule === 'ttl' ? entry.expiresAt > now : entry.gen === state.gen;
}

// The map only ever grows on a miss, so that is where it is pruned. Cache keys
// rotate by design (a URL carrying a day range, a minute-quantized cutoff), so
// without this a long-lived process accumulates one dead entry per rotation
// forever. Pruning only once the map is past a threshold keeps the ordinary
// miss O(1); the threshold sits well above the number of live keys a busy
// session holds (one per analytics URL, one per project's commit count).
const SWEEP_ABOVE = 256;

// Two passes, because the first one on its own does not bound anything.
// Sweeping drops the entries a staleness rule already killed, which on a busy
// server is most of them. But a rotating key can stay FRESH forever: the
// fixed-window key carries a minute-quantized cutoff, so a process that is
// only being read from mints a new generation entry every minute and never
// bumps the generation that would kill the old ones, so the sweep frees nothing
// and re-scans a map that keeps growing. So cap on top, oldest insertion
// first (Map iterates in insertion order). Every value in here is
// recomputable by definition, so an over-eager drop costs one recompute.
function prune(now: number): void {
  for (const [key, entry] of state.map) {
    if (!isFresh(entry, now)) state.map.delete(key);
  }
  if (state.map.size <= SWEEP_ABOVE) return;
  for (const key of state.map.keys()) {
    if (state.map.size <= SWEEP_ABOVE) break;
    state.map.delete(key);
  }
}

// Bump the generation so every generation-ruled entry (already stored or yet
// to be stored) is treated as stale on its next read. Call this at the end of
// every DB write path (session/project insert, update, delete). TTL entries are
// deliberately untouched: their input is not the database.
export function invalidateCache(): void {
  state.gen++;
}

// How many entries the cache is holding, live and stale alike. cacheSize is
// exported for the boundedness pin in test/server-cache.test.mjs, which has no other way to
// see that the sweep runs; nothing in production reads it.
export function cacheSize(): number {
  return state.map.size;
}

// Returns the cached value for `key` when its staleness rule says it is still
// good; otherwise calls `compute()`, stores the result, and returns it. Pass
// `ttlMs` to give the entry an expiry instead of a generation. If `compute()`
// returns a Promise that rejects, the entry is evicted so the failure isn't
// repeated on later reads: the next call retries instead of waiting for an
// invalidation or a TTL.
export function cached<T>(key: string, compute: () => T, ttlMs?: number): T {
  const now = Date.now();
  const entry = state.map.get(key);
  if (entry && isFresh(entry, now)) {
    return entry.value as T;
  }
  const value = compute();
  if (state.map.size > SWEEP_ABOVE) prune(now);
  state.map.set(key, ttlMs === undefined
    ? { rule: 'generation', gen: state.gen, value }
    : { rule: 'ttl', expiresAt: now + ttlMs, value });
  if (value instanceof Promise) {
    value.catch(() => {
      const current = state.map.get(key);
      if (current && current.value === value) state.map.delete(key);
    });
  }
  return value;
}
