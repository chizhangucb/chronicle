// Client side of the per-boot gate token (CHI-323 D2, ported from Varde).
//
// Every mutating call carries the per-boot token, fetched once and cached: a
// hostile page can fire cross-origin POSTs at the loopback server but cannot
// read the token GET, so its POSTs die at the server's check. A 403 refetches
// the token once, which covers a console-server restart under an open tab.
//
// The whole app's writes funnel through `j()` in ../api.ts, which calls
// gateToken()/gateHeaders() here; the gate-surface UI (Safety/Jobs) reuses the
// same cache so there is one token per tab, not one per caller.

let cachedToken: string | null = null;

export async function gateToken(refetch = false): Promise<string> {
  if (!cachedToken || refetch) {
    const res = await fetch('/api/gate/token');
    if (!res.ok) throw new Error('gate token unavailable');
    cachedToken = ((await res.json()) as { token: string }).token;
  }
  return cachedToken;
}

/** Header set for mutating routes carrying the per-boot token. */
export async function gateHeaders(refetch = false): Promise<Record<string, string>> {
  return { 'x-gate-token': await gateToken(refetch) };
}

/** Clear the cache (test seam; also lets a caller force a refetch). */
export function resetGateToken(): void {
  cachedToken = null;
}
