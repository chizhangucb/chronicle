// The four sources, in one place (#308). A caller that used to branch on the
// source string looks the source up here instead; adding a fifth coding tool is
// a parser file and one line in this list (ADR 0004).
//
// Separate from source.ts so the interface module stays a leaf: the parsers
// import the interface, this imports the parsers.
import type { SourceId } from '../../shared/types.ts';
import type { Source } from './source.ts';
import { claudeCodeSource } from './claudeCode.ts';
import { codexSource } from './codex.ts';
import { cursorSource } from './cursor.ts';
import { opencodeSource } from './opencode.ts';

export const SOURCES: Source[] = [claudeCodeSource, codexSource, cursorSource, opencodeSource];

// The source that reads this tool's transcripts, or undefined for a source no
// parser covers yet (`gemini`, `copilot`) — a caller decides what to do about
// that rather than being handed a source that reads nothing. Takes a plain
// string, because the two callers that most need it hold one: `sessions.source`
// is untyped TEXT in the DB (shared/rows.ts) and a query string is whatever the
// operator typed.
export function sourceById(id: SourceId | string): Source | undefined {
  return SOURCES.find((s) => s.id === id);
}
