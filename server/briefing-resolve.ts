/**
 * Condition-based auto-resolve + the all-days ledger merge (ported from Varde,
 * CHI-323 3d). Two pure machines the runner drives on every run:
 *
 * 1. mergeRuns: the briefing file is a LEDGER across run days. New cards land; a
 *    re-emitted id refreshes content but keeps its ORIGINAL runAt.
 * 2. checkCardResolved / autoResolve: every card kind with a deterministic
 *    evidence condition is re-checked against the CURRENT snapshot. When the
 *    condition no longer fires, the card resolves itself, however it got fixed.
 *    Code decides, never the model.
 *
 * D7: the spend-card conditions (spend-anomaly, budget-posture) are omitted —
 * those cards are not emitted this phase. Non-spend conditions (jobs / egress /
 * safety / source freshness) are re-checked; other kinds return null (left alone).
 */
import type { BriefingCard, BriefingFile, BriefingStateFile, CardStateEntry } from './briefing.ts';

export const LEDGER_KEEP_DAYS = 90;

interface LiveShape {
  generatedAt?: string;
  jobs?: { jobs?: { id: string; status: string; lastExit?: number | null }[] };
  egress?: { enabled?: boolean; gateConfigFound?: boolean };
  safetyGaps?: { actionable?: { title?: string; id?: string }[] };
}

const slugify = (s: string): string => s.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '');

/** Deterministic re-check for one card. true = condition no longer fires
 * (resolve), false = still fires (stands), null = no deterministic condition. */
export function checkCardResolved(card: BriefingCard, live: unknown, now: Date): boolean | null {
  const data = (live ?? {}) as LiveShape;
  switch (card.kind) {
    case 'job-failure': {
      const jobId = card.id.slice('job-failure:'.length);
      const row = data.jobs?.jobs?.find((j) => j.id === jobId);
      if (!row) return false;
      return row.status === 'success' && (row.lastExit == null || row.lastExit === 0);
    }
    case 'job-stale': {
      const jobId = card.id.slice('job-stale:'.length);
      const row = data.jobs?.jobs?.find((j) => j.id === jobId);
      if (!row) return false;
      return row.status === 'success' || row.status === 'running';
    }
    case 'source-stale': {
      const stamp = data.generatedAt ? new Date(data.generatedAt).getTime() : NaN;
      if (!Number.isFinite(stamp)) return false;
      return now.getTime() - stamp < 24 * 3_600_000;
    }
    case 'egress-off': {
      if (data.egress?.gateConfigFound !== true) return false;
      return data.egress.enabled === true;
    }
    case 'safety-gap': {
      const slug = card.id.slice('safety-gap:'.length);
      const actionable = data.safetyGaps?.actionable;
      if (!Array.isArray(actionable)) return false;
      return !actionable.some((g) => slugify(g.title ?? '') === slug || g.id === slug);
    }
    default:
      return null;
  }
}

/** Merge a new run's cards over the existing ledger. New ids append; a
 * re-emitted id refreshes in place but keeps its first runAt. Terminal cards
 * older than LEDGER_KEEP_DAYS drop off. */
export function mergeRuns(previous: BriefingCard[], next: BriefingCard[], state: BriefingStateFile, now: Date): BriefingCard[] {
  const nextById = new Map(next.map((c) => [c.id, c]));
  const cutoff = now.getTime() - LEDGER_KEEP_DAYS * 86_400_000;
  const merged: BriefingCard[] = [];
  for (const old of previous) {
    const fresh = nextById.get(old.id);
    if (fresh) { merged.push({ ...fresh, runAt: old.runAt }); nextById.delete(old.id); continue; }
    const entry = state.cards[old.id];
    const terminal = entry && entry.state !== 'open' && entry.state !== 'snoozed';
    const stamp = new Date(terminal ? entry.at : old.runAt).getTime();
    if (terminal && Number.isFinite(stamp) && stamp < cutoff) continue;
    merged.push(old);
  }
  for (const card of nextById.values()) merged.push(card);
  return merged;
}

export interface AutoResolveResult { state: BriefingStateFile; resolvedIds: string[] }

/** Re-check every still-live card against the current snapshot and mark cleared
 * ones "resolved". The ONE place anything other than the operator writes state,
 * and it only ever writes "resolved" (done/dismissed stay untouchable). */
export function autoResolve(file: BriefingFile, state: BriefingStateFile, live: unknown, now: Date): AutoResolveResult {
  const cards = { ...state.cards };
  const resolvedIds: string[] = [];
  for (const card of file.cards) {
    const entry = cards[card.id];
    const liveState = entry?.state ?? 'open';
    if (liveState !== 'open' && liveState !== 'snoozed') continue;
    if (checkCardResolved(card, live, now) !== true) continue;
    const next: CardStateEntry = { ...(entry ?? {}), state: 'resolved', at: now.toISOString() };
    delete next.snoozedUntil;
    cards[card.id] = next;
    resolvedIds.push(card.id);
  }
  return { state: { version: 1, cards }, resolvedIds };
}
