import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMdTableSectionWithHeader } from './md-table.ts';

/**
 * Scheduled-tasks registry + heartbeat health (ported from Varde, CHI-323 3c).
 * Reads operations.md `## Scheduled tasks` and derives each job's live health
 * from the heartbeat the job-runner wrapper stamps at
 * `<hub>/.tmp/heartbeats/<name>.json`. Pure derivation (now injected), read-only.
 */

export interface ScheduledJob {
  name: string;
  schedule: string;
  maxStaleness: string;
  runner: string;
  lastRun: string;
  description: string;
  status: 'active';
}

export interface AutomationRow {
  name: string;
  cadence: string;
  lastRun: string;
  lastRunAt?: string | null;
  nextRun: string;
  status: 'success' | 'failed' | 'stale' | 'pending' | string;
  source?: 'cowork' | 'codex' | 'claude' | 'hub-registry';
  description?: string;
  meta?: string;
}

export interface Heartbeat {
  job_id: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  runner: string;
  mode?: string;
}

/** Finds `## Scheduled tasks` and maps its table BY HEADER NAME so column order
 * can move. Rows missing a Job cell are dropped. */
export function parseScheduledTasks(md: string): ScheduledJob[] {
  const { header, rows } = parseMdTableSectionWithHeader(md, 'Scheduled tasks');
  if (header.length === 0) return [];
  const col = (name: string) => header.indexOf(name);
  const iName = col('Job');
  const iSched = col('Schedule');
  const iStale = col('Max staleness');
  const iRunner = col('Runner');
  const iLast = col('Last run');
  const iDesc = col('What it does');
  if (iName < 0) return [];
  const at = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? '') : '');
  return rows
    .map((cells): ScheduledJob | null => {
      const name = at(cells, iName);
      if (!name) return null;
      return {
        name, schedule: at(cells, iSched), maxStaleness: at(cells, iStale),
        runner: at(cells, iRunner), lastRun: at(cells, iLast), description: at(cells, iDesc),
        status: 'active' as const,
      };
    })
    .filter((job): job is ScheduledJob => job !== null);
}

/** A "Max staleness" cell ("8d", "26h") -> ms; blank/"-" -> null. */
export function parseStalenessMs(cell: string): number | null {
  const m = /(\d+)\s*([dh])/.exec(cell || '');
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'd' ? n * 86_400_000 : n * 3_600_000;
}

function fmtAge(ms: number): string {
  if (ms < 60_000) return 'just now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function readHeartbeat(hubRoot: string, name: string): Heartbeat | null {
  try {
    return JSON.parse(readFileSync(join(hubRoot, '.tmp', 'heartbeats', `${name}.json`), 'utf8')) as Heartbeat;
  } catch {
    return null;
  }
}

/** Derive an AutomationRow from a registry row + its heartbeat (now injected):
 *   no heartbeat -> pending · non-zero exit -> failed · age>threshold -> stale ·
 *   else -> success. A liveness beat (exit null + fresh) is healthy. */
export function deriveAutomationRow(job: ScheduledJob, beat: Heartbeat | null, now: Date): AutomationRow {
  const base = {
    name: job.name, cadence: job.schedule, nextRun: 'n/a', source: 'hub-registry' as const,
    ...(job.description ? { description: job.description } : {}),
  };
  if (!beat) {
    return { ...base, lastRun: job.lastRun || 'never', status: 'pending', meta: `no heartbeat yet - threshold ${job.maxStaleness || 'n/a'}` };
  }
  const stampStr = beat.ended_at ?? beat.started_at;
  const stamp = stampStr ? new Date(stampStr) : null;
  const ageMs = stamp && !Number.isNaN(stamp.getTime()) ? now.getTime() - stamp.getTime() : null;
  const thresholdMs = parseStalenessMs(job.maxStaleness);
  const failed = beat.exit_code != null && beat.exit_code !== 0;
  const overdue = thresholdMs != null && ageMs != null && ageMs > thresholdMs;
  const status = failed ? 'failed' : overdue ? 'stale' : 'success';
  const alive = beat.mode === 'liveness' && beat.exit_code == null;
  const lastRun = ageMs != null ? (alive ? `alive, ${fmtAge(ageMs)}` : fmtAge(ageMs)) : 'unknown';
  const exitBit = failed ? `exit ${beat.exit_code} - ` : '';
  const meta = `${exitBit}threshold ${job.maxStaleness || 'n/a'}`;
  return { ...base, lastRun, lastRunAt: ageMs != null && stamp ? stamp.toISOString() : null, status, meta };
}

/** Reads operations.md, parses the scheduled-tasks table, derives live health
 * from heartbeats. Missing operations.md -> empty slice (no throw). */
export function collectAutomations(hubRoot: string, now: Date = new Date()): AutomationRow[] {
  const path = join(hubRoot, 'operations.md');
  let md: string;
  try {
    md = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return parseScheduledTasks(md).map((job) => deriveAutomationRow(job, readHeartbeat(hubRoot, job.name), now));
}
