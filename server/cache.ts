// The one cache every server-side memo goes through: the heavy analytics
// routes (insights, explore, content, per-project analytics), the Insights
// engine's commit counts and fixed windows, and ask's claude-binary probe.
//
// Two staleness rules, and an entry can carry both. GENERATION is the default:
// every DB write path calls invalidateCache(), which bumps the counter, so a
// cached entry whose stored generation no longer matches the current one is a
// miss. TTL is opt-in per entry, for the values whose input is NOT the
// database — a `git rev-list` count, a `which claude` probe — where nothing
// bumps the generation when the answer changes and expiry is what bounds the
// staleness. An entry with a TTL is still generation-keyed, so an import makes
// it stale immediately rather than at the end of its window.
//
// State lives on globalThis so Vite SSR module reloads (dev) don't reset it
// mid-session — same pattern as server/live.ts / server/autosync.ts.
interface CacheEntry<T> {
  gen: number;
  // Wall-clock deadline for a TTL entry; absent when the entry expires only on
  // an invalidation.
  expiresAt?: number;
  value: T;
}

interface CacheState {
  gen: number;
  map: Map<string, CacheEntry<unknown>>;
}

declare global {
  // eslint-disable-next-line no-var
  var __chronicleCache: CacheState | undefined;
}

const state: CacheState = (globalThis.__chronicleCache ??= { gen: 0, map: new Map() });

// Bump the generation so every cache entry (already stored or yet to be
// stored) is treated as stale on its next read. Call this at the end of
// every DB write path (session/project insert, update, delete).
export function invalidateCache(): void {
  state.gen++;
}

// Returns the cached value for `key` if it was computed at the current
// generation and has not passed its TTL; otherwise calls `compute()`, stores
// the result, and returns it. `ttlMs`, when given, also expires the entry that
// many milliseconds after it was stored. If `compute()` returns a Promise that
// rejects, the entry is evicted so the failure isn't repeated on later reads —
// the next call retries instead of waiting for an invalidation.
export function cached<T>(key: string, compute: () => T, ttlMs?: number): T {
  const entry = state.map.get(key);
  if (entry && entry.gen === state.gen && (entry.expiresAt === undefined || entry.expiresAt > Date.now())) {
    return entry.value as T;
  }
  const value = compute();
  state.map.set(key, { gen: state.gen, expiresAt: ttlMs === undefined ? undefined : Date.now() + ttlMs, value });
  if (value instanceof Promise) {
    value.catch(() => {
      const current = state.map.get(key);
      if (current && current.value === value) state.map.delete(key);
    });
  }
  return value;
}
