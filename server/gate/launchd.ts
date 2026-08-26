/* eslint-disable @typescript-eslint/no-explicit-any -- reason below */
/**
 * Why `any` is allowed in this file:
 * inspects an unvalidated gate change payload before it has been through the
 * shape check. Treating it as typed is precisely the mistake the gate exists to
 * prevent.
 *
 * launchd pause/resume as a gated action surface (ported from Varde, CHI-323).
 * Pause is `launchctl bootout` of the loaded job; resume is `launchctl
 * bootstrap` of the ~/Library/LaunchAgents plist. The plist itself is never
 * edited, so a resume restores exactly the installed schedule. Confirm-first:
 * propose -> card -> confirm; nothing writes without the card. Demo refuses.
 *
 * The named LAUNCHD_JOBS shortcuts (and listJobs) are populated by the Jobs
 * organ (1e); this action controls any explicit launchd `label` today.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { GateError, type ActionImpl, type DiffEntry } from './core.ts';

/** Named job shortcuts (job key -> launchd label). Chronicle's own jobs ship
 * DORMANT (3c) and the com.chronicle.* labels land with the Jobs organ (1e);
 * until then the action operates on any explicit label. */
export const LAUNCHD_JOBS: Record<string, string> = {};

/** Reverse-DNS-ish launchd label: dot-separated identifier, nothing else. */
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');

function domain(): string {
  return `gui/${userInfo().uid}`;
}

export function jobState(label: string): 'running' | 'paused' {
  const r = spawnSync('launchctl', ['print', `${domain()}/${label}`], { encoding: 'utf-8' });
  return r.status === 0 ? 'running' : 'paused';
}

export function listJobs() {
  return Object.entries(LAUNCHD_JOBS).map(([job, label]) => ({
    job,
    label,
    state: jobState(label),
    installed: existsSync(join(AGENTS_DIR, `${label}.plist`)),
  }));
}

function parseChange(change: unknown): { label: string; action: 'pause' | 'resume' } {
  // Demo posture: a demo console never touches this machine's real launchd
  // jobs. Refused at propose time, before any card exists.
  if (process.env.CHRONICLE_DEMO === '1') {
    throw new GateError(409, 'demo seed, job control disabled', 'copy the launchctl command and run it yourself on a real console');
  }
  const action = String((change as any)?.action ?? '');
  const short = String((change as any)?.job ?? '');
  const label = String((change as any)?.label ?? '') || LAUNCHD_JOBS[short] || '';
  if (!label) {
    const known = Object.keys(LAUNCHD_JOBS);
    throw new GateError(400, `unknown job "${short}"`, known.length ? `pass a launchd label, or one of: ${known.join(', ')}` : 'pass a launchd label');
  }
  if (!LABEL_RE.test(label)) {
    throw new GateError(400, `"${label}" is not a valid launchd label`, 'labels are dot-separated identifiers');
  }
  if (action !== 'pause' && action !== 'resume') {
    throw new GateError(400, 'action must be "pause" or "resume"', 'send a valid action');
  }
  if (action === 'resume' && !existsSync(join(AGENTS_DIR, `${label}.plist`))) {
    throw new GateError(409, `${label} has no plist in ~/Library/LaunchAgents`, 'only installed jobs can be resumed; install it first');
  }
  return { label, action };
}

export const launchdAction: ActionImpl = {
  describe(change): DiffEntry[] {
    const { label, action } = parseChange(change);
    const from = jobState(label);
    const to = action === 'pause' ? 'paused' : 'running';
    if (from === to) return [];
    return [{ path: label, from, to }];
  },

  execute(change): string {
    const { label, action } = parseChange(change);
    if (action === 'pause') {
      const r = spawnSync('launchctl', ['bootout', `${domain()}/${label}`], { encoding: 'utf-8' });
      if (r.status !== 0 && jobState(label) === 'running') {
        throw new GateError(500, `launchctl bootout failed: ${(r.stderr || r.stdout || '').trim()}`, 'check the job label with `launchctl print`');
      }
    } else {
      const link = join(AGENTS_DIR, `${label}.plist`);
      if (!existsSync(link)) {
        throw new GateError(409, `${label} is not installed (no plist in ~/Library/LaunchAgents)`, 'install the job first; only installed jobs can be resumed');
      }
      const r = spawnSync('launchctl', ['bootstrap', domain(), link], { encoding: 'utf-8' });
      if (r.status !== 0 && jobState(label) === 'paused') {
        throw new GateError(500, `launchctl bootstrap failed: ${(r.stderr || r.stdout || '').trim()}`, 'check the plist with `plutil -lint`');
      }
    }
    const state = jobState(label);
    const want = action === 'pause' ? 'paused' : 'running';
    if (state !== want) {
      throw new GateError(500, `verify failed: ${label} is ${state}, expected ${want}`, 'inspect with `launchctl print`');
    }
    return `${label} is now ${state}`;
  },
};
