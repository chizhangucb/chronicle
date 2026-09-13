// What the two breadcrumb pickers show, minus the JSX (issue #381).
//
// The dropdowns live next door in Pickers.tsx; the part that decides which
// rows a typed query keeps, and how a row is titled and dated, is plain data,
// so it sits here where it can be read on its own (test/pickers.test.mjs).
//
// Named for the `Pickable*` shapes it owns, not `rows`: shared/rows.ts already
// means "what a route answers with", and these are neither.
import { sessionDisplayName, type NamedSession } from '../../shared/sessionName.ts';

// Minimal project shape the picker needs (a subset of Project, plus the
// aggregate columns GET /api/projects adds server-side).
export interface PickableProject {
  id: number | string;
  name: string;
  path?: string;
  session_count?: number;
  last_active?: string | null;
}

// Minimal session shape the picker needs.
export interface PickableSession extends NamedSession {
  id: string;
  message_count?: number;
  started_at?: string | null;
}

// How much of a session's name one dropdown row has room for.
const TITLE_CHARS = 48;

// The title a session row renders: the ONE display name (shared/sessionName.ts,
// the 'label' presentation), cut to the row's width.
export function sessionPickerTitle(s: PickableSession): string {
  return sessionDisplayName(s, 'label').slice(0, TITLE_CHARS);
}

// A project is kept on its name or its path, either case; an empty query keeps
// every row.
export function matchesProjectQuery(p: PickableProject, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return p.name.toLowerCase().includes(needle) || (p.path || '').toLowerCase().includes(needle);
}

// A session is kept on the title the row renders (either case) or on its id.
// The id half is compared as typed: an id is a hex handle being pasted, not
// prose being searched.
export function matchesSessionQuery(s: PickableSession, q: string): boolean {
  if (!q) return true;
  return sessionPickerTitle(s).toLowerCase().includes(q.toLowerCase()) || String(s.id).includes(q);
}

// The "when" on a picker row: whole days, all either dropdown has room for.
// `now` is injected the way shared display helpers here take it, so the
// wording can be asserted without a wall clock.
export function ago(ts: string, now: number = Date.now()): string {
  const d = Math.round((now - +new Date(ts)) / 86400000);
  return d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`;
}
