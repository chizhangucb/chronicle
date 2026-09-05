import { useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { api, type ViewLogActor } from './api.js';

// The client half of the local-only view log (CHI-325 3a). It answers one
// question over time: which surfaces actually earn their space. See
// server/viewlog.ts for why it exists and what it may never become.
//
// Best-effort by construction. Every send is fire-and-forget with the failure
// swallowed: a log that can break a navigation is worse than no log.
//
// LIFECYCLE (the non-obvious part). A row is OPENED on arrival and its dwell is
// filled in on departure, rather than being written once at the end carrying
// both. End-only writing looks simpler and is wrong: a full page load tears
// down the document while the closing request is still in flight, so whole
// visits vanish and the visit COUNT stops being trustworthy. Opening on arrival
// makes the count exact and demotes dwell to best-effort; a visit whose close
// was lost keeps a null dwell, which reads as "unknown", not as a bounce.

/** Instance -> PATTERN. The server keeps its own allowlist and rejects anything
 *  it does not recognize, so this is the first of two gates, not the only one.
 *  Never send '/session/8f3a...': the log records which SURFACE was used, not
 *  which session was read, and that distinction is the table's privacy story. */
export function routePattern(path: string): string | null {
  if (path === '/') return '/';
  if (path === '/insights') return '/';        // redirect-only route, same surface
  if (/^\/project\/[^/]+/.test(path)) return '/project/:id';
  if (/^\/session\/[^/]+/.test(path)) return '/session/:id';
  const flat = ['/projects', '/reference', '/ask'];
  return flat.includes(path) ? path : null;
}

/**
 * The browser's own verdict (D5). `navigator.webdriver` is set by Playwright,
 * Puppeteer and Selenium in BOTH headed and headless modes, which makes it the
 * one signal that catches a CDP-driven real browser.
 *
 * What it does NOT catch: an extension driving the user's own profile. Those
 * report webdriver false and dispatch trusted events, so they read as human
 * here. That hole is why the server stores this verdict alongside its own
 * rather than collapsing them. See server/viewlog.ts collapseActor.
 */
export function clientActor(): ViewLogActor {
  try {
    return navigator.webdriver === true ? 'agent' : 'human';
  } catch {
    return 'agent';   // no navigator at all is not a person at a browser
  }
}

/** How recently a trusted input event must have happened for a navigation to
 *  count as gesture-driven. Stored, never acted on today: it is one more column
 *  a future re-derivation can use. */
const GESTURE_WINDOW_MS = 5000;

interface Open {
  /** Server row id, null until the POST answers. A navigation faster than the
   *  round trip loses that one dwell rather than blocking on it. */
  id: number | null;
  route: string;
  detail: string | null;
  startedAt: number;
}

/**
 * Mount ONCE, at the app root. `tab` is the active hub/project tab when the
 * current surface has tabs, so the log can tell "opened /" from "lives in the
 * Spend tab", which is the actual question when deciding whether a tab earns
 * its space.
 */
export function useViewLog(tab?: string | null): void {
  const [location] = useLocation();
  const open = useRef<Open | null>(null);
  const lastGesture = useRef(0);

  // Trusted-input tracking. `isTrusted` is true for CDP-dispatched events too,
  // so this is corroboration, not proof: stored for later, not decisive now.
  useEffect(() => {
    const mark = (e: Event) => { if (e.isTrusted) lastGesture.current = Date.now(); };
    window.addEventListener('pointerdown', mark, { capture: true, passive: true });
    window.addEventListener('keydown', mark, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', mark, { capture: true });
      window.removeEventListener('keydown', mark, { capture: true });
    };
  }, []);

  useEffect(() => {
    const route = routePattern(location);
    const detail = tab ?? null;
    const prev = open.current;
    if (prev && prev.route === route && prev.detail === detail) return;

    const now = Date.now();
    const closes = prev && prev.id != null ? [{ id: prev.id, dwellMs: now - prev.startedAt }] : [];

    if (!route) {
      open.current = null;
      if (closes.length) api.viewLog([], closes).catch(() => { /* best-effort */ });
      return;
    }

    // ARRIVING at a route is a 'visit'; changing tab WITHIN the route we are
    // already on is a 'tab'. Keyed on the route rather than on whether a tab
    // exists, because the hub at / always has one ('overview' by default) and
    // a naive "tab ? tab : visit" would mean / never recorded a visit at all
    // and vanished from the surface ranking entirely.
    const event: 'visit' | 'tab' = prev && prev.route === route ? 'tab' : 'visit';
    const mine: Open = { id: null, route, detail, startedAt: now };
    open.current = mine;

    api.viewLog(
      [{ route, event, detail, actor: clientActor(), gesture: now - lastGesture.current < GESTURE_WINDOW_MS }],
      closes,
    )
      .then((r) => {
        // Only adopt the id if we are still on the row it belongs to; a fast
        // navigation may already have moved on, and stamping the id onto the
        // NEXT row would close the wrong visit.
        if (open.current === mine) mine.id = r.ids?.[0] ?? null;
      })
      .catch(() => { /* best-effort, never surfaced */ });
  }, [location, tab]);

  // Close the open row when the tab is hidden or the page goes away. This is
  // the path that can lose a request to teardown, which is exactly why the row
  // was already written on arrival: what is at risk here is one duration, not
  // the visit itself.
  useEffect(() => {
    const closeOut = () => {
      const p = open.current;
      if (!p || p.id == null) return;
      open.current = null;
      api.viewLog([], [{ id: p.id, dwellMs: Date.now() - p.startedAt }]).catch(() => { /* ignore */ });
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') closeOut(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', closeOut);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', closeOut);
    };
  }, []);
}

/**
 * Record one allowlisted key interaction (D6). Fire-and-forget; the server
 * drops anything not on its ACTIONS allowlist, so adding a call here without
 * adding the id there is a silent no-op by design rather than a schema change.
 */
export function logAction(route: string, action: string): void {
  const pattern = routePattern(route);
  if (!pattern) return;
  api.viewLog([{ route: pattern, event: 'action', detail: action, actor: clientActor(), gesture: true }])
    .catch(() => { /* best-effort */ });
}
