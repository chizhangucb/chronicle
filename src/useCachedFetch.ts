// Client stale-while-revalidate fetch layer (spec §2.8 — perceived-<300ms nav):
// with server responses now cache-warm (Task 3), the client's job is to never
// blank a previously-rendered pane on tab/page switches. A module-level cache
// keyed by URL means any component that has ever fetched a given URL renders
// that data INSTANTLY on the next mount (e.g. switching back to a tab), then
// refreshes in place — a skeleton only ever appears on a true cold load
// (this exact URL has never resolved in this session).
import { useEffect, useRef, useState } from 'react';
import { fetchJson } from './api.ts';

// Untyped at rest (`unknown`) since one process-wide cache serves every
// caller's distinct `T` — each read casts back to the caller's own generic
// (`as T`), which is the idiomatic escape hatch here (never `any`/`@ts-ignore`).
const cache = new Map<string, unknown>();

export interface CachedFetchResult<T> {
  data: T | null;
  stale: boolean;
  refresh: () => void;
}

export function useCachedFetch<T>(url: string): CachedFetchResult<T> {
  const [data, setData] = useState<T | null>(() => (cache.has(url) ? (cache.get(url) as T) : null));
  const [stale, setStale] = useState<boolean>(() => cache.has(url));
  // Bumped on every load (mount, url change, or manual refresh) so an
  // in-flight response from a superseded call — the url changed again, or a
  // newer refresh() started — is detected and dropped instead of clobbering
  // fresher state (the "stale closure" guard called for in the brief).
  const epochRef = useRef(0);

  function load(forUrl: string) {
    const epoch = ++epochRef.current;
    // Cached data for this exact URL is already on screen (or about to be,
    // via the effect below) — mark it stale while the revalidation is in
    // flight rather than clearing it.
    if (cache.has(forUrl)) setStale(true);
    fetchJson<T>(forUrl)
      .then((json) => {
        if (epochRef.current !== epoch) return; // superseded — ignore
        cache.set(forUrl, json);
        setData(json);
        setStale(false);
      })
      .catch(() => {
        if (epochRef.current !== epoch) return; // superseded — ignore
        // A failed (re)fetch must never blank a previously-rendered pane —
        // leave `data` exactly as it was, just stop showing "refreshing".
        setStale(false);
      });
  }

  useEffect(() => {
    const hit = cache.has(url);
    setData(hit ? (cache.get(url) as T) : null);
    setStale(hit);
    load(url);
    // `load` is a fresh closure each render but stable in behavior (keyed
    // only on its `forUrl` argument); re-running this effect on anything but
    // a `url` change would defeat the cache-hit fast path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return { data, stale, refresh: () => load(url) };
}

// Fire-and-forget cache warm — used by picker `onMouseEnter` so the list is
// already resolved by the time the user clicks (no fetch, no flash of
// "Loading…" in the popover). A no-op if the URL is already cached; errors
// are swallowed since there's no caller waiting on the result — the next
// real `useCachedFetch`/`prefetch` call for this URL will just try again.
export function prefetch(url: string): void {
  if (cache.has(url)) return;
  fetchJson(url)
    .then((json) => { cache.set(url, json); })
    .catch(() => {});
}
