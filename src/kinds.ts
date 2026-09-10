// Canonical chat-type labels — the single source of truth for how each message
// kind is described in the UI. Playback (SessionView), Refine (RefineMode) and the
// Refine export all read from here so the vocabulary can never diverge again
// (previously Playback said "You"/"AI" while Refine said "USER"/"ASSISTANT").
// Role-accurate wording; icons live alongside per-view since styling differs.
//
// Keyed by DisplayKind = the canonical parser `Kind`s PLUS the client-only 'note'
// ('Inserted') display kind (user-inserted Refine notes never hit a parser/db).
import type { DisplayKind } from '@shared/types.ts';

export const KIND_LABEL: Record<DisplayKind, string> = {
  user: 'User',
  assistant: 'Assistant',
  thinking: 'Thinking',
  tool_use: 'Tool Call',
  tool_result: 'Tool Result',
  note: 'Inserted',
};

export const KIND_ICON: Record<DisplayKind, string> = {
  user: '👤',
  assistant: '✳',
  thinking: '💭',
  tool_use: '🔧',
  tool_result: '↩',
  note: '＋',
};
