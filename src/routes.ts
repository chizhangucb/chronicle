// The paths the app has a page for, in one place.
//
// App.tsx matches each pattern to decide which page renders. It reads the same
// list through `isKnownPath` to decide when NOTHING matches, so an unrouted
// path lands on the not-found surface instead of the chrome around an empty
// main area. One list: a route added here is a route the fallback already
// knows about, and neither half can drift from the other.
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
export const KNOWN_ROUTES: readonly string[] = Object.values(ROUTES);

/**
 * One pattern as a matcher, spelled exactly as the router spells it: literal
 * segments match themselves, a `:param` segment matches one non-empty segment
 * that carries no slash, and a trailing slash is optional. Case is ignored,
 * as the router ignores it. Matching the router's own semantics is what keeps
 * `isKnownPath` and the mounted pages answering the same way for the same URL.
 */
function toMatcher(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? '/[^/]+' : `/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    .join('');
  return new RegExp(`^${body}/?$`, 'i');
}

const MATCHERS = KNOWN_ROUTES.map(toMatcher);

/** Does `path` (a location, no query or hash) reach a page the app mounts? */
export function isKnownPath(path: string): boolean {
  return MATCHERS.some((re) => re.test(path));
}
