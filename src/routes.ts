import { matchRoute } from 'wouter';
import { parse } from 'regexparam';

// The paths the app has a page for, in one place.
//
// App.tsx matches each pattern to decide which page renders, and reads the
// same table through `isRoutedPath` to decide when NOTHING matches, so an
// unrouted path lands on the not-found surface instead of on this frame around
// an empty main area. One table: a route added here is a route the fallback
// already knows about, and neither half can drift from the other.
export const ROUTES = {
  home: '/',
  projects: '/projects',
  project: '/project/:id',
  projectExplore: '/project/:id/explore',
  projectContent: '/project/:id/content',
  session: '/session/:id',
  insights: '/insights',
  ask: '/ask',
  reference: '/reference',
} as const;

/** Every pattern above, as the fallback reads them. */
// Exported for test/not-found-route.test.mjs: KNOWN_ROUTES is what it counts App.tsx's
// matched patterns against; isRoutedPath is its production reader.
export const KNOWN_ROUTES: readonly string[] = Object.values(ROUTES);

/**
 * Does `path` (a location, no query and no hash) reach a page the app mounts?
 *
 * Asked of the router's OWN matcher, not of a second reading of a pattern:
 * `matchRoute` is what `useRoute` calls, and `parse` is the parser the default
 * router hands it. A hand-rolled matcher would answer a trailing slash, a
 * cased path or a wildcard pattern its own way, and the disagreement would
 * show up as the fallback stacked under a page that did match.
 */
export function isRoutedPath(path: string): boolean {
  return KNOWN_ROUTES.some((pattern) => matchRoute(parse, pattern, path)[0]);
}
