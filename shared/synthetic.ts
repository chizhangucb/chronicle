// shared/synthetic.ts
// The ONE definition of "this role=user message is not a human prompt". Ported
// from the two former copies (server/durations.ts + src/session/stats.ts) so the
// active-time metric and the display-name fallback can never drift apart.
// Relative-import value module (never @shared), B3 — imported by both server
// parsers/duration math and client session stats.
//
// Not every role=user message is a human turn: task notifications, system
// reminders, command wrappers, interrupts, and cross-session (agent-to-agent
// IPC) messages all log with role=user. Their preceding gap counts as ACTIVE
// (the agent/app was busy, or another agent messaged in) — only a genuinely
// typed prompt subtracts time — and none of them should ever surface as a
// session's display name (CHI-368).
//
// Anchored at the start ON PURPOSE: a real human prompt that merely quotes or
// discusses one of these tags mid-sentence must NOT be misread as synthetic.
// The cross-session case is stored as the exact preamble "Another Claude
// session sent a message:\n<cross-session-message …>" (confirmed across real
// logs); the `<cross-session-message` tag alternative is the durable signal if
// that preamble wording ever changes.
export const SYNTHETIC_USER_RE = /^\s*(?:<task-notification|<launch-selected-element|<system-reminder|<command-name|<command-message|<local-command|\[Request interrupted|Another Claude session sent a message:|<cross-session-message)/;

export function isSyntheticUserText(text: string | null | undefined): boolean {
  return SYNTHETIC_USER_RE.test(text || '');
}
