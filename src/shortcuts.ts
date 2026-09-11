// The one place that decides which modifier key a keyboard hint names.
//
// Every shortcut handler in the client accepts Command OR Control
// (`e.metaKey || e.ctrlKey`), so the shortcuts themselves work everywhere. The
// hints did not: they were written with `⌘` by hand, which names a key a
// Windows or Linux keyboard does not have (issue #366). No surface writes a
// modifier symbol itself any more; every one of them asks here.

/** The hint for one chord, e.g. `⌘K` on macOS and `Ctrl+K` everywhere else. */
export function shortcutHint(key: string, opts: { shift?: boolean; platform?: string } = {}): string {
  const platform = opts.platform ?? hostPlatform();
  if (usesCommandKey(platform)) return `${opts.shift ? '⇧' : ''}⌘${key}`;
  return ['Ctrl', ...(opts.shift ? ['Shift'] : []), key].join('+');
}

/**
 * Does this platform's keyboard carry a Command key?
 *
 * Apple's is the only one that does; everything else gets Control. The answer
 * is read from a platform STRING rather than the environment so the decision
 * is testable without a browser.
 */
function usesCommandKey(platform: string): boolean {
  return /mac|iphone|ipad|ipod|darwin/i.test(platform);
}

/**
 * What this host calls itself, best effort.
 *
 * `userAgentData.platform` is the modern answer ("macOS", "Windows"),
 * `navigator.platform` the one Safari still gives ("MacIntel"), and the user
 * agent string the last resort ("… Macintosh …"). A host that answers none of
 * the three reads as Control, the modifier every keyboard has. (Node answers
 * the first two with browser-shaped strings of its own — "MacIntel", "Win32",
 * "Linux x86_64" — so off a browser the hint still follows the machine.)
 */
function hostPlatform(): string {
  const nav = globalThis.navigator as (Navigator & { userAgentData?: { platform?: string } }) | undefined;
  if (!nav) return '';
  return nav.userAgentData?.platform || nav.platform || nav.userAgent || '';
}
