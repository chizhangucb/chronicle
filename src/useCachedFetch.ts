// Client stale-while-revalidate fetch layer (spec §2.8 — perceived-<300ms nav):
// with server responses now cache-warm, the client's job is to never
// blank a previously-rendered pane on tab/page switches OR on a param change
// (day-range, pivot, etc.) that lands on a URL this session hasn't seen yet.
// A module-level cache keyed by URL means any component that has ever fetched
// a given URL renders that data INSTANTLY on the next mount, then refreshes
// in place — a skeleton only ever appears when NOTHING has ever been shown
// for this hook instance (true cold load).
import { useEffect, useRef, useState } from 'react';
import { fetchJson } from './api.ts';

// Untyped at rest (`unknown`) since one process-wide cache serves every
// caller's distinct `T` — each read casts back to the caller's own generic
// (`as T`), which is the idiomatic escape hatch here (never `any`/`@ts-ignore`).
const cache = new Map<string, unknown>();

// In-flight request dedup: two components mounting at once and asking for the
// SAME url (e.g. ProjectDetail's own `allProjects` color-map fetch and
// ProjectPicker's list, both reading '/api/projects') must not each fire a
// separate GET — they share the one Promise already in flight for that URL.
const inflight = new Map<string, Promise<unknown>>();

function fetchDeduped<T>(url: string): Promise<T> {
  const existing = inflight.get(url) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fetchJson<T>(url).finally(() => {
    if (inflight.get(url) === p) inflight.delete(url);
  });
  inflight.set(url, p);
  return p;
}

// Live hook instances to poke on invalidation. Clearing `cache` alone is not
// enough: a component like `ProjectPicker` stays mounted with the SAME url
// ('/api/projects') for its whole lifetime, so its `useCachedFetch` effect
// (keyed on `[url]`) never re-runs on its own — without this, a rename made
// elsewhere would leave that already-mounted instance showing the stale name
// for the rest of the session, cache-clear or not.
const listeners = new Set<() => void>();

// Bumped by every `invalidateClientCache()` call. `load()` and `prefetch()`
// each snapshot this at request-start and refuse to commit their response to
// `cache`/component state if it's moved on by the time the response lands —
// see the long comment on `invalidateClientCache()` for why this (not just
// `inflight.clear()`, and not just the per-instance `epochRef`) is what
// makes the "no pre-invalidation payload can land after it" invariant hold
// for EVERY write path, including `prefetch()` (which has no epoch of its
// own to be superseded by).
let generation = 0;

// Called from mutation paths (rename/delete/associate/unlink/…) that change
// server state this cache might be holding stale copies of.
//
// This has to do three things, in this order, to be airtight against a
// specific race: a GET for this same URL that was ALREADY in flight before
// the mutation (e.g. ProjectDetail's `allProjects` fetch and ProjectPicker's
// list fetch, both firing unconditionally on mount and deduped via
// `fetchDeduped` to one shared, possibly-slow, Promise) must not be allowed
// to land its PRE-mutation payload into the cache/UI after this call returns
// — even though, thanks to `inflight` dedup, more than one live consumer may
// already be chained onto that one Promise.
//
//  1. `generation++` — every in-flight request's `gen` snapshot (taken at
//     its own `load`/`prefetch` call) is now stale, so its `.then` becomes a
//     no-op no matter which Promise it happens to be chained to.
//  2. `inflight.clear()` — forces every reload the `listeners` loop below
//     triggers to issue a BRAND NEW request instead of `fetchDeduped` handing
//     it the same pre-mutation Promise from step-0 (that Promise is now an
//     orphan: still resolving, but nothing new attaches to it after this
//     point, and everything already attached is covered by #1 and by each
//     instance's own `epochRef`, bumped the moment its listener re-runs
//     `load()`).
//  3. `cache.clear()` + notify `listeners` — the actual refetch.
//
// Clearing the whole map (rather than per-URL bookkeeping) is deliberately
// simple/blunt — the server's own result cache makes any resulting
// refill cheap.
export function invalidateClientCache(): void {
  generation++;
  inflight.clear();
  cache.clear();
  for (const notify of listeners) notify();
}

export interface CachedFetchResult<T> {
  data: T | null;
  stale: boolean;
  // Set when the most recent (re)fetch for this URL failed. Only meaningful
  // to act on when `data` is still null (a true cold-load failure — nothing
  // has ever rendered for this hook instance): callers that want a hard error
  // state (e.g. a 404 "Not found" banner) should gate on `error && !data`.
  // A background revalidation failure (data already present) also sets this,
  // but per the "never blank a working pane" rule callers should generally
  // ignore it in that case — the stale data stays correct-enough on screen.
  error: string | null;
  refresh: () => void;
}

export function useCachedFetch<T>(url: string): CachedFetchResult<T> {
  const [data, setData] = useState<T | null>(() => (cache.has(url) ? (cache.get(url) as T) : null));
  const [stale, setStale] = useState<boolean>(() => cache.has(url));
  const [error, setError] = useState<string | null>(null);
  // Mirrors `data` synchronously — component state updates are batched/async,
  // so `load` (called from inside the url-change effect, in the same tick as
  // a fresh render) needs a synchronous read of "do we currently have
  // anything on screen" that doesn't depend on a possibly-stale closure over
  // last render's `data`.
  const dataRef = useRef<T | null>(data);
  // Bumped on every load (mount, url change, manual refresh) AND on effect
  // cleanup (url change or unmount) — the codebase's cancelled-flag pattern,
  // expressed as a counter so an in-flight response is dropped if superseded
  // by a newer call OR if the component moved past this url entirely.
  const epochRef = useRef(0);

  function load(forUrl: string) {
    const epoch = ++epochRef.current;
    // Snapshot the invalidation generation at request-start (see
    // `invalidateClientCache()`) — the response is only committed below if
    // NEITHER guard has fired: `epoch` covers this instance being superseded
    // by a newer/different load, `generation` covers the whole cache having
    // been invalidated (and a new request already issued) while this
    // specific request was still in flight.
    const gen = generation;
    const hasSomethingToShow = cache.has(forUrl) || dataRef.current !== null;
    if (cache.has(forUrl)) {
      // A cache hit for the NEW url — show it immediately.
      dataRef.current = cache.get(forUrl) as T;
      setData(dataRef.current);
    }
    // Cache miss for the new url: deliberately do NOT touch `data` here.
    // Whatever was already on screen (this url's previous fetch, or — after a
    // param change that lands on a never-seen url — the PREVIOUS url's data)
    // stays exactly as-is; only a genuinely-never-shown-anything hook
    // instance is left at `data === null` (the true cold-load/skeleton case).
    if (hasSomethingToShow) setStale(true);
    setError(null);
    fetchDeduped<T>(forUrl)
      .then((json) => {
        if (epochRef.current !== epoch || generation !== gen) return; // superseded or invalidated mid-flight — ignore
        cache.set(forUrl, json);
        dataRef.current = json;
        setData(json);
        setStale(false);
      })
      .catch((err: unknown) => {
        if (epochRef.current !== epoch || generation !== gen) return; // superseded or invalidated mid-flight — ignore
        setStale(false);
        setError(err instanceof Error ? err.message : 'Failed to load');
      });
  }

  useEffect(() => {
    load(url);
    // Re-run `load` for THIS instance's current url whenever anyone calls
    // `invalidateClientCache()` — not just on a `url` change — so a mutation
    // made elsewhere (e.g. renaming a project while ProjectPicker is mounted
    // with its url unchanged) is picked up immediately, not just by the next
    // component that happens to mount fresh.
    const onInvalidate = () => load(url);
    listeners.add(onInvalidate);
    // `load` is a fresh closure each render but stable in behavior (keyed
    // only on its `forUrl` argument); re-running this effect on anything but
    // a `url` change would defeat the cache-hit fast path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      epochRef.current++; // cancel: drop any response still in flight for this url
      listeners.delete(onInvalidate);
    };
  }, [url]);

  return { data, stale, error, refresh: () => load(url) };
}

// Fire-and-forget cache warm — used by picker `onMouseEnter` so the list is
// already resolved by the time the user clicks (no fetch, no flash of
// "Loading…" in the popover). A no-op if the URL is already cached (or
// already in flight, via `fetchDeduped`); errors are swallowed since there's
// no caller waiting on the result — the next real `useCachedFetch`/`prefetch`
// call for this URL will just try again.
//
// `prefetch` has no per-call instance to own an `epochRef`, so it's the one
// write path with nothing to supersede it on its own — the `generation`
// snapshot/check is what stops a prefetch that was already in flight before
// a rename/delete from writing that stale payload into the cache after the
// fact (e.g. hover-prefetching the project list, then renaming before the
// hover's GET resolves).
export function prefetch(url: string): void {
  if (cache.has(url)) return;
  const gen = generation;
  fetchDeduped(url)
    .then((json) => { if (generation === gen) cache.set(url, json); })
    .catch(() => {});
}
