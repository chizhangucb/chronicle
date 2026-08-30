import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DiffEntry } from './core.ts';

/**
 * Narrowing rules for the approval policy. Every function here may only ever
 * ADD a card to a surface declared `approval: 'auto'`; none can grant auto to a
 * surface that did not declare it. See Surface.narrow in core.ts for why that
 * one-way property is load-bearing.
 */

/**
 * Pausing a launchd job is mechanically reversible: the plist is never edited,
 * so a resume restores exactly the installed schedule. That is why the surface
 * is auto. But some jobs ARE the machinery that reports on itself, and
 * "reversible" is no comfort when nothing is left to tell you it happened.
 * Pausing those shows the diff first.
 *
 * Matched as case-insensitive substrings of the launchd label, describing what
 * a job DOES, deliberately not who owns it. Chronicle ships publicly on npm, so
 * a hardcoded list of one machine's job labels would both leak that machine's
 * setup to every user and protect nobody else: another operator's critical jobs
 * are named differently. Function words generalise; personal labels do not.
 *
 * Over-matching is the safe direction. A job called `db-maintenance` cards on
 * pause when it did not strictly need to, which costs one click.
 */
export const PROTECTED_JOB_PATTERNS: readonly string[] = [
  'hermes',      // the OOB approval channel: every card rides it
  'egress',      // egress gating and approval delivery
  'gating',
  'security',
  'audit',
  'backup',
  'maintenance', // the recurring stage that runs gating/hygiene checks
  'hygiene',
  'watchdog',
  'sentinel',
];

/**
 * Operator extension at `~/.chronicle/protected-jobs.json`:
 *
 *   { "labels": ["com.example.my-critical-job"], "patterns": ["compliance"] }
 *
 * Exact labels and extra patterns are ADDITIVE only; nothing here can remove a
 * shipped pattern, so a malformed or hostile file can never widen what
 * auto-approves. Unreadable or malformed content is ignored rather than
 * throwing, and core.ts cards anything whose classification throws either way.
 */
function operatorExtras(): { labels: string[]; patterns: string[] } {
  const path = join(process.env.CHRONICLE_DATA_DIR || join(homedir(), '.chronicle'), 'protected-jobs.json');
  if (!existsSync(path)) return { labels: [], patterns: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { labels?: unknown; patterns?: unknown };
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return { labels: strings(raw.labels), patterns: strings(raw.patterns) };
  } catch {
    return { labels: [], patterns: [] };
  }
}

/** Whether pausing this label needs the card. Exported for the Jobs UI so it can
 * say so before the operator clicks. */
export function isProtectedJob(label: string): boolean {
  const lower = label.toLowerCase();
  const extra = operatorExtras();
  if (extra.labels.includes(label)) return true;
  return [...PROTECTED_JOB_PATTERNS, ...extra.patterns].some((p) => lower.includes(p.toLowerCase()));
}

/** launchd pause/resume: resume always restores, so it never cards. Pause cards
 * for the protected set. */
export function narrowLaunchd(change: unknown, _diff: DiffEntry[]): string | null {
  const c = (change ?? {}) as { action?: unknown; label?: unknown };
  if (String(c.action ?? '') !== 'pause') return null;
  const label = String(c.label ?? '');
  if (!label || !isProtectedJob(label)) return null;
  return label.toLowerCase().includes('hermes')
    ? 'pausing the approval channel would stop every future confirmation card from reaching you'
    : `${label} looks like enforcement or reporting machinery, so pausing it shows the diff first`;
}
