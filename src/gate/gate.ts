// Browser client for the confirm-first write channel (/api/gate/*), ported from
// Varde (CHI-323). Propose -> card -> confirm/deny. Every mutating call carries
// the per-boot token from token.ts (one 403 refetch covers a server restart).
import { gateToken } from './token.ts';

export interface GateDiffEntry { path: string; from: unknown; to: unknown }

export interface GateProposal {
  id: string;
  surfaceId: string;
  reason: string;
  diff: GateDiffEntry[];
  requiresCode: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface GateSurfaceStatus {
  id: string;
  title: string;
  description?: string;
  tier: 1 | 2;
  mode?: 'confirm' | 'allow';
  writeVia?: 'direct' | 'hub-script';
  available: boolean;
  unavailableReason?: string;
}

/** Gate failures carry the server's fix line; surfacing it beats "500". */
export class GateError extends Error {
  fix?: string;
  constructor(message: string, fix?: string) {
    super(message);
    this.fix = fix;
  }
}

async function tokenPost(path: string, body: unknown): Promise<Response> {
  const once = async (refetch: boolean) =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gate-token': await gateToken(refetch) },
      body: JSON.stringify(body),
    });
  let res = await once(false);
  if (res.status === 403) res = await once(true);
  return res;
}

async function gatePost<T>(path: string, body: unknown): Promise<T> {
  const res = await tokenPost(path, body);
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new GateError(parsed?.error ?? `${res.status} ${res.statusText}`, parsed?.fix);
  return parsed as T;
}

/** Step 1: validate + card. Nothing is written until gateConfirm. */
export async function gatePropose(surface: string, change: unknown, reason: string): Promise<GateProposal> {
  const { proposal } = await gatePost<{ proposal: GateProposal }>('/api/gate/propose', { surface, change, reason });
  return proposal;
}

export async function gateConfirm(id: string, decision: 'confirm' | 'deny', code?: string): Promise<void> {
  await gatePost('/api/gate/confirm', { id, decision, ...(code ? { code } : {}) });
}

/** One-shot write, allow-mode surfaces only (the click is the intent). */
export async function gateApply(surface: string, change: unknown, reason: string): Promise<void> {
  await gatePost('/api/gate/apply', { surface, change, reason });
}

/** Registry with resolved availability (hub surfaces are unavailable without a
 * hub checkout; the UI renders them disabled, with why). */
export async function gateSurfaces(): Promise<GateSurfaceStatus[]> {
  const res = await fetch('/api/gate/surfaces');
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new GateError(parsed?.error ?? `${res.status} ${res.statusText}`, parsed?.fix);
  return (parsed.surfaces as GateSurfaceStatus[]) ?? [];
}

/** Current browser-safe view of a surface's target (JSON text or null). */
export async function gateSurfaceText(id: string): Promise<string | null> {
  const res = await fetch(`/api/gate/surface?id=${encodeURIComponent(id)}`);
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new GateError(parsed?.error ?? `${res.status} ${res.statusText}`, parsed?.fix);
  return (parsed.text as string | null) ?? null;
}
