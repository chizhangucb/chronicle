// Open an external URL in the user's real browser. Under Electron the preload
// exposes window.chronicleShell (→ shell.openExternal in the main process); in
// dev/standalone (browser) that bridge is undefined, so we fall back to a normal
// new tab. Guarded exactly like UpdateBanner guards window.chronicleUpdater.
export function openExternal(url) {
  if (window.chronicleShell?.openExternal) window.chronicleShell.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
