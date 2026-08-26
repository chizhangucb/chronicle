/**
 * The "work on this" launcher (ported from Varde, CHI-323 3d): opens a Terminal
 * with `claude "<prompt>"` TYPED on the command line, UNSUBMITTED, so the
 * operator reads and edits before anything runs. Uses zsh's `print -z` (pushes
 * the command onto the line editor) via osascript, so no System Events
 * keystrokes and no accessibility permission. The prompt is ALWAYS built
 * server-side from the gap register, never from the browser (the client sends a
 * gap id only). Pure builders so quoting is testable without opening terminals.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** POSIX single-quote escaping: the only metacharacter left is ' itself. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export interface LaunchCommand {
  /** What ends up typed on the operator's command line. */
  buffer: string;
  /** argv for osascript. */
  osascriptArgs: string[];
}

/** The safety-gap review prompt. Same wording the Safety page's clipboard
 * fallback uses; built server-side so the typed prompt never comes from the
 * browser. Pure so the wording is testable. */
export function gapReviewPrompt(
  gap: { title: string; exposure?: string; blastRadius?: string; acceptedWhy?: string; acceptedDate?: string },
  watch: boolean,
): string {
  return [
    `Review the ${watch ? 'watch-listed' : 'actionable'} safety gap "${gap.title}" on my machine.`,
    gap.exposure ? `Exposure: ${gap.exposure}` : null,
    gap.blastRadius ? `Blast radius: ${gap.blastRadius}` : null,
    gap.acceptedWhy ? `Accepted ${gap.acceptedDate || '(undated)'} because: ${gap.acceptedWhy}` : null,
    'Assess whether that acceptance still holds today and propose the smallest concrete change that would close the gap.',
  ].filter(Boolean).join('\n');
}

export function buildLaunchCommand(prompt: string, cwd?: string): LaunchCommand {
  // One line only: raw newlines cannot ride through an AppleScript string
  // literal, and a multi-line buffer invites a stray submit.
  const flat = prompt.replaceAll(/\s+/g, ' ').trim();
  const dir = cwd?.startsWith('~') ? join(homedir(), cwd.slice(1)) : cwd;
  const buffer = `${dir ? `cd ${shellQuote(dir)} && ` : ''}claude ${shellQuote(flat)}`;
  // print -z needs the buffer as ONE shell word, quoted again.
  const inner = `print -z -- ${shellQuote(buffer)}`;
  // Innermost first: shell quoting above, AppleScript string escaping here.
  const appleQuoted = inner.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const script = `tell application "Terminal"\nactivate\ndo script "${appleQuoted}"\nend tell`;
  return { buffer, osascriptArgs: ['-e', script] };
}
