// shared/sessionName.ts
// The ONE session display name, on both sides of the wire. The server resolves
// it for activity's top session and Explore's group=session label; the client
// renders it on the Sessions tab, the session picker, the Overview title and
// search rows, including for a LIVE session that has no stored row yet. It
// lives here so those two answers cannot disagree — it used to be a server
// copy plus a near-copy client twin.
//
// Relative-import value module (never @shared), same B3 rule as
// shared/pricing.ts and shared/errors.ts.

import { isSyntheticUserText } from './synthetic.ts';

// How the last rung of the fallback chain is presented. The precedence above
// it (operator-set name → summary → first prompt) is the same either way; this is the only
// thing the two former twins disagreed about.
//   'id'    — the whole session id, the stable handle a server row is keyed
//             on and what an engine's row label needs.
//   'label' — `Session 3f2a1b9c`: the id prefixed and shortened for a UI that
//             is showing it to a person, and a bare `Session` when the row has
//             no id yet.
export type NamePresentation = 'id' | 'label';

// Deliberately loose so callers with slightly different session-like shapes
// (a server row keyed on id/name/summary/first_prompt, SearchModal's search
// results) can pass their row directly.
export interface NamedSession {
  id?: string | number | null;
  name?: string | null;
  summary?: string | null;
  first_prompt?: string | null;
}

const ID_LABEL_CHARS = 8;

export function sessionDisplayName(s: NamedSession, presentation: NamePresentation): string {
  // Read-path guard: a first_prompt that is a synthetic wrapper (command echo
  // / cross-session IPC) is treated as absent, so a session imported BEFORE
  // the parser fix still never shows a raw `<…>` wrapper — it falls through to
  // the id. Fresh imports already store a clean first_prompt.
  const fp = s.first_prompt && !isSyntheticUserText(s.first_prompt) ? s.first_prompt : null;
  const named = (s.name && s.name.trim()) || (s.summary && s.summary.trim()) || fp;
  if (named) return named;
  const id = s.id ? String(s.id) : '';
  if (presentation === 'id') return id;
  return id ? `Session ${id.slice(0, ID_LABEL_CHARS)}` : 'Session';
}
