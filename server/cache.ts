// Generation-keyed result cache for the heavy analytics routes (insights,
// explore, content, per-project analytics). No TTL: correctness comes from
// invalidation, not expiry. Every DB write path calls invalidateCache(),
// which bumps the generation counter; a cached entry whose stored generation
// no longer matches the current one is treated as a miss and recomputed.
// State lives on globalThis so Vite SSR module reloads (dev) don't reset it
// mid-session — same pattern as server/live.ts / server/autosync.ts.
interface CacheEntry<T> {
  gen: number;
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
// generation; otherwise calls `compute()`, stores the result at the current
// generation, and returns it. If `compute()` returns a Promise that rejects,
// the entry is evicted so the failure isn't repeated on later reads — the
// next call retries instead of waiting for an invalidation.
export function cached<T>(key: string, compute: () => T): T {
  const entry = state.map.get(key);
  if (entry && entry.gen === state.gen) {
    return entry.value as T;
  }
  const value = compute();
  state.map.set(key, { gen: state.gen, value });
  if (value instanceof Promise) {
    value.catch(() => {
      const current = state.map.get(key);
      if (current && current.value === value) state.map.delete(key);
    });
  }
  return value;
}
