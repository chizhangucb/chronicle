// server/hub/slices/records.ts
// Records slice (CHI-324 2h / review B1 — phase 1 never shipped this): read-only
// views of a nisse-shaped hub's append-only records streams (CHI-313 JSONL).
// Ported from Varde's aggregator/sources/records.ts. Two files, both
// append-only JSONL:
//   - records/decisions.jsonl: one object per decision block, oldest FIRST.
//     Row: {date, title, session, stream, body}. Only date/title are read.
//   - records/sessions.jsonl: one object per session (order not guaranteed, so
//     sorted newest-first by stamp). Row: {stamp, session, focus, repo}.
// Only index-level fields are read — the decision BODY (the "why") stays in the
// hub, never emitted (confidentiality floor: titles/paths/cells only). Missing
// files are a normal posture, not an error; a malformed/partial trailing line
// is skipped. Phase 2's /records UI ships ONLY the sessions type; decisions is
// carried for the future switcher stub.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RecordsDecision {
  /** YYYY-MM-DD when the row carries a date; null otherwise. */
  date: string | null;
  title: string;
}

export interface RecordsLedgerRow {
  /** The session stamp: "YYYY-MM-DD HHMM". */
  date: string;
  sessionId: string;
  focus: string;
  /** `hub` or a satellite repo name; null on rows without the column. */
  repo: string | null;
}

export interface RecordsSlice {
  /** At least one records file was readable. */
  found: boolean;
  decisions: { total: number; recent: RecordsDecision[] };
  /** `recent` is the peek; `rows` is the COMPLETE ledger for the click-to-extend
   * view (small four-cell rows, so the full list rides the response). */
  ledger: { total: number; recent: RecordsLedgerRow[]; rows: RecordsLedgerRow[] };
}

const RECENT_DECISIONS = 12;
const RECENT_LEDGER_ROWS = 15;

function readOrNull(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

// Split a JSONL blob into parsed objects; blank + malformed/partial (incl. an
// unterminated trailing) lines are skipped rather than throwing.
function parseJsonlLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>);
    } catch { /* skip a malformed / partially-written line */ }
  }
  return out;
}

// decisions.jsonl rows (oldest-first) -> { date, title }, file order kept.
export function parseDecisionRows(text: string): RecordsDecision[] {
  return parseJsonlLines(text).map((row) => ({
    date: typeof row.date === 'string' && row.date ? row.date : null,
    title: typeof row.title === 'string' ? row.title : '',
  }));
}

// sessions.jsonl rows -> ledger rows, sorted newest-first by stamp.
export function parseLedgerRows(text: string): RecordsLedgerRow[] {
  const rows: RecordsLedgerRow[] = [];
  for (const row of parseJsonlLines(text)) {
    const sessionId = typeof row.session === 'string' ? row.session : '';
    if (!sessionId) continue;
    rows.push({
      date: typeof row.stamp === 'string' ? row.stamp : '',
      sessionId,
      focus: typeof row.focus === 'string' ? row.focus : '',
      repo: typeof row.repo === 'string' && row.repo ? row.repo : null,
    });
  }
  // Stamps are "YYYY-MM-DD HHMM", so a lexicographic desc sort is chronological.
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows;
}

export function collectRecords(hubRoot: string): RecordsSlice {
  const decisionsRaw = readOrNull(join(hubRoot, 'records', 'decisions.jsonl'));
  const ledgerRaw = readOrNull(join(hubRoot, 'records', 'sessions.jsonl'));

  const decisions = decisionsRaw ? parseDecisionRows(decisionsRaw) : [];
  const decisionsNewestFirst = [...decisions].reverse(); // file is oldest-first
  const ledger = ledgerRaw ? parseLedgerRows(ledgerRaw) : [];

  return {
    found: decisionsRaw !== null || ledgerRaw !== null,
    decisions: { total: decisions.length, recent: decisionsNewestFirst.slice(0, RECENT_DECISIONS) },
    ledger: { total: ledger.length, recent: ledger.slice(0, RECENT_LEDGER_ROWS), rows: ledger },
  };
}

export const EMPTY_RECORDS: RecordsSlice = {
  found: false,
  decisions: { total: 0, recent: [] },
  ledger: { total: 0, recent: [], rows: [] },
};
