// Client side of the per-boot write token (server/writeToken.ts).
//
// Fetched once and cached per tab. A hostile page can fire cross-origin POSTs
// at the loopback server but cannot read the token GET, so its POSTs die at the
// server's check. A 403 refetches once, which covers a server restart under an
// already-open tab.
//
// Every write in the app funnels through `j()` in ./api.ts, which is the only
// caller here.

let cachedToken: string | null = null;

export const WRITE_TOKEN_HEADER = 'x-chronicle-write-token';

export async function writeToken(refetch = false): Promise<string> {
  if (!cachedToken || refetch) {
    const res = await fetch('/api/write-token');
    if (!res.ok) throw new Error('write token unavailable');
    cachedToken = ((await res.json()) as { token: string }).token;
  }
  return cachedToken;
}

/** Clear the cache (test seam; also lets a caller force a refetch). */
export function resetWriteToken(): void {
  cachedToken = null;
}
