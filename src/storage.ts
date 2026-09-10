// Every localStorage key Chronicle owns, plus the one-time migration off the
// names that predate the convention (issue #202).
//
// The convention is `chronicle.<name>`, camelCase after the dot. Two keys were
// written before it settled — the sidebar collapse state (`chronicle-sidebar`)
// and playback's chat/code split (`chronicle-playback-split`) — so an operator
// upgrading has state parked under a name nothing reads any more.
// `migrateLegacyStorageKeys()` runs once on load (src/main.tsx, before the
// first render, so every component's mount-time read already sees the dot key),
// copies each old value over and deletes the old key. Nothing writes an old key
// again: the copy is one-way and the old names live only in `LEGACY_KEYS`.
//
// All storage access is guarded — private mode, a full quota and any SSR/test
// import path all have to be survivable, same as `useResizable.ts`'s reads.

/** The keys, by the name the code uses for the state they hold. */
export const STORAGE_KEYS = {
  /** Sidebar collapse state: `'collapsed'` | `'expanded'` (App.tsx). */
  sidebarCollapsed: 'chronicle.sidebar',
  /** Expanded sidebar width, px (App.tsx via useResizable). */
  sidebarWidth: 'chronicle.sidebarW',
  /** Playback's chat column width, px (SessionView.tsx via useResizable). */
  playbackSplit: 'chronicle.playbackSplit',
  /** Real/theoretical cost toggle (costMode.tsx). */
  costMode: 'chronicle.costMode',
  /** ISO timestamp of the last visit, for the "since you were away" read. */
  lastVisit: 'chronicle.lastVisit',
  /** Pre-`/settings` monthly budget, read once and moved server-side. */
  monthlyBudget: 'chronicle.monthlyBudget',
} as const;

/** Old name → the dot key it moves to. Read-only: nothing writes the old name. */
const LEGACY_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['chronicle-sidebar', STORAGE_KEYS.sidebarCollapsed],
  ['chronicle-playback-split', STORAGE_KEYS.playbackSplit],
];

/**
 * Move any value still parked under a pre-convention key onto its dot key, then
 * delete the old key. A value already under the dot key wins — the migration
 * never overwrites current state — and a missing old key is a no-op, so the
 * whole thing is idempotent and cheap to call on every load.
 */
export function migrateLegacyStorageKeys(): void {
  if (typeof localStorage === 'undefined') return;
  for (const [oldKey, newKey] of LEGACY_KEYS) {
    try {
      const value = localStorage.getItem(oldKey);
      if (value == null) continue;
      if (localStorage.getItem(newKey) == null) localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    } catch {
      /* storage unavailable (private mode / quota) — nothing to migrate */
    }
  }
}
