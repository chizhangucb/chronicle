// Canonical chat-type labels — the single source of truth for how each message
// kind is described in the UI. Playback (SessionView), Refine (RefineMode) and the
// Refine export all read from here so the vocabulary can never diverge again
// (previously Playback said "You"/"AI" while Refine said "USER"/"ASSISTANT").
// Role-accurate wording; icons live alongside per-view since styling differs.
export const KIND_LABEL = {
  user: 'User',
  assistant: 'Assistant',
  thinking: 'Thinking',
  tool_use: 'Tool Call',
  tool_result: 'Tool Result',
  note: 'Inserted',
};

export const KIND_ICON = {
  user: '👤',
  assistant: '✳',
  thinking: '💭',
  tool_use: '🔧',
  tool_result: '↩',
  note: '＋',
};
