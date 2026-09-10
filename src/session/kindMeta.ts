// What a Playback row draws in front of a message: the glyph, the label and the
// per-view CSS class, resolved from a message's kind.
//
// The glyph and the label come from the canonical map (src/kinds.ts) so Playback,
// Refine and the Refine export can never diverge; only the row's CSS class is
// this view's own. It lives here rather than inside MessageRow.tsx so the
// resolution is reachable without a DOM (test/kind-icons.test.mjs) — a wrong
// glyph in a row is otherwise only visible to the e2e suite.
import { KIND_ICON, KIND_LABEL } from '../kinds.ts';
import type { DisplayKind } from '../../shared/types.ts';

export interface KindMeta { icon: string; label: string; cls: string; }

const KIND_CLS: Record<DisplayKind, string> = {
  user: 'user', assistant: 'assistant', thinking: 'thinking', tool_use: 'tool', tool_result: 'tool-result', note: 'note',
};

const KIND_META: Record<string, KindMeta> = Object.fromEntries(
  (Object.keys(KIND_CLS) as DisplayKind[]).map((k) => [k, { icon: KIND_ICON[k], label: KIND_LABEL[k], cls: KIND_CLS[k] }]),
);

/**
 * Row chrome for `kind`. An unrecognized kind (a parser growing a sixth one, a
 * live row arriving ahead of the client) falls back to a mono bullet and the
 * raw kind as its own label, so the row still renders and still says what it is.
 */
export function metaFor(kind: string): KindMeta {
  return KIND_META[kind] ?? { icon: '•', label: kind, cls: '' };
}
