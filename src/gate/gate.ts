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
  /** Why this change is carding rather than applying (CHI-329). */
  cardReason?: string;
  createdAt: string;
  expiresAt: string;
}

export interface GateSurfaceStatus {
  id: string;
  title: string;
  description?: string;
  tier: 1 | 2;
  /** CHI-329 posture. Absent means confirm. */
  approval?: 'auto' | 'confirm';
  writeVia?: 'direct' | 'hub-script';
  available: boolean;
  unavailableReason?: string;
}

export interface GateApplied {
  applied: string;
  backup: string | null;
  target: string;
  diff: GateDiffEntry[];
}

/**
 * The outcome of a write request. The SERVER decides which one you get: the
 * client never picks between "apply this" and "card this", so there is no
 * softer endpoint for a caller to reach for.
 */
export type GateOutcome =
  | { applied: true; result: GateApplied }
  | { applied: false; proposal: GateProposal };

export interface GateAuditRow {
  ts: string;
  event: 'proposed' | 'confirmed' | 'denied' | 'expired' | 'failed' | 'allowed';
  surface: string;
  proposalId: string;
  actor: string;
  reason: string;
  diff: GateDiffEntry[];
  backup?: string;
  error?: string;
  detail?: Record<string, unknown>;
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

/**
 * Submit a write (CHI-329). Returns either an already-applied result (the
 * policy classified it auto) or a proposal to card. Callers render one or the
 * other; they never choose which.
 *
 * `source: 'suggestion'` marks machine-generated content, which always cards.
 * Not a security boundary (see core.ts) but it keeps the app's own
 * scope-suggest flow honest about showing its diff for review.
 */
export async function gateSubmit(
  surface: string,
  change: unknown,
  reason: string,
  source: 'operator' | 'suggestion' = 'operator',
): Promise<GateOutcome> {
  return gatePost<GateOutcome>('/api/gate/propose', { surface, change, reason, source });
}

/** Undo a completed write from its backup. Meets the same policy as any other
 * change, so it can come back as a card. */
export async function gateUndo(proposalId: string): Promise<GateOutcome> {
  return gatePost<GateOutcome>('/api/gate/undo', { proposalId });
}

export async function gateAudit(): Promise<GateAuditRow[]> {
  const res = await fetch('/api/gate/audit');
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new GateError(parsed?.error ?? `${res.status} ${res.statusText}`, parsed?.fix);
  return (parsed.rows as GateAuditRow[]) ?? [];
}

export async function gateConfirm(id: string, decision: 'confirm' | 'deny', code?: string): Promise<void> {
  await gatePost('/api/gate/confirm', { id, decision, ...(code ? { code } : {}) });
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
