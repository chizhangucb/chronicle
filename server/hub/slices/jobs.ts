/**
 * Every scheduled thing on this machine, in one list (ported from Varde, CHI-323
 * 3c). Four sources in descending authority: launchd (~/Library/LaunchAgents +
 * live launchctl state), cron (user crontab), registry (hub scheduled-tasks +
 * heartbeats), repo templates (launchd templates the repo ships but you have not
 * installed). Read-only throughout: nothing here installs, starts, stops or
 * edits a job. Attribution (runner/model/agent) is best-effort, never a guess.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AutomationRow } from './automations.ts';

export type JobSource = 'launchd' | 'cron' | 'registry' | 'repo-template';

export type JobStatus =
  | 'success' | 'failed' | 'stale' | 'pending' | 'running' | 'not-installed' | 'disabled' | 'paused';

export interface JobRow {
  id: string;
  name: string;
  source: JobSource;
  schedule: string;
  scheduleKind: 'calendar' | 'interval' | 'prose' | 'manual' | 'unknown';
  nextRun: string | null;
  lastRun: string | null;
  lastRunAt: string | null;
  status: JobStatus;
  lastExit: number | null;
  runner: string | null;
  model: string | null;
  agent: string | null;
  project: string | null;
  projectPath: string | null;
  command: string;
  logPath: string | null;
  errLogPath?: string | null;
  missingPath?: string | null;
  description?: string | null;
  meta?: string;
}

export interface JobsSlice {
  scannedAt: string;
  sources: Record<JobSource, number>;
  jobs: JobRow[];
}

// ---- Command attribution ----
const AGENT_PATTERNS: [RegExp, string][] = [
  [/\bclaude\b/, 'claude'], [/\bcodex\b/, 'codex'], [/\bcursor(-agent)?\b/, 'cursor'],
  [/\bgemini\b/, 'gemini'], [/\baider\b/, 'aider'], [/\bgoose\b/, 'goose'],
];

export interface Attribution { runner: string | null; model: string | null; agent: string | null }

/** Pull runner/model/agent out of an argv. Wrapper-aware: a job that runs
 * `python3 run_job.py <name> -- <real command>` attributes to the command after
 * the `--`. Only `--model` long form (a `-m` is python's module flag far more
 * often than a model flag). */
export function attributeCommand(argv: string[]): Attribution {
  const separator = argv.indexOf('--');
  const effective = separator >= 0 && separator < argv.length - 1 ? argv.slice(separator + 1) : argv;
  const joined = effective.join(' ');
  const runner = effective[0] ? basename(effective[0]) : null;
  let model: string | null = null;
  for (let i = 0; i < effective.length; i += 1) {
    const arg = effective[i];
    if (arg === '--model') { model = effective[i + 1] ?? null; break; }
    if (arg.startsWith('--model=')) { model = arg.slice('--model='.length); break; }
  }
  const agent = AGENT_PATTERNS.find(([pattern]) => pattern.test(joined))?.[1] ?? null;
  return { runner, model, agent };
}

// ---- Schedules ----
export interface CalendarSpec { Minute?: number; Hour?: number; Day?: number; Weekday?: number; Month?: number }
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n: number): string => String(n).padStart(2, '0');

export function describeCalendar(specs: CalendarSpec[]): string {
  return specs.map((spec) => {
    const time = spec.Hour != null ? `${pad(spec.Hour)}:${pad(spec.Minute ?? 0)}` : `:${pad(spec.Minute ?? 0)}`;
    if (spec.Weekday != null) return `${WEEKDAYS[spec.Weekday % 7]} ${time}`;
    if (spec.Day != null) return `monthly on day ${spec.Day} at ${time}`;
    if (spec.Hour != null) return `daily ${time}`;
    return `every hour at ${time}`;
  }).join(', ');
}

export function describeInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `every ${seconds / 60}m`;
  return `every ${seconds}s`;
}

export function nextCalendarRun(specs: CalendarSpec[], now: Date): Date | null {
  if (!specs.length) return null;
  const start = new Date(now.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const matches = (date: Date, spec: CalendarSpec): boolean =>
    (spec.Minute == null || date.getMinutes() === spec.Minute) &&
    (spec.Hour == null || date.getHours() === spec.Hour) &&
    (spec.Day == null || date.getDate() === spec.Day) &&
    (spec.Weekday == null || date.getDay() === spec.Weekday % 7) &&
    (spec.Month == null || date.getMonth() + 1 === spec.Month);
  const limit = 40 * 24 * 60;
  const cursor = new Date(start.getTime());
  for (let step = 0; step < limit; step += 1) {
    if (specs.some((spec) => matches(cursor, spec))) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

export interface CronEntry { schedule: string; fields: string[]; command: string }

export function parseCrontab(text: string): CronEntry[] {
  const SHORTCUTS: Record<string, string[]> = {
    '@yearly': ['0', '0', '1', '1', '*'], '@annually': ['0', '0', '1', '1', '*'],
    '@monthly': ['0', '0', '1', '*', '*'], '@weekly': ['0', '0', '*', '*', '0'],
    '@daily': ['0', '0', '*', '*', '*'], '@midnight': ['0', '0', '*', '*', '*'],
    '@hourly': ['0', '*', '*', '*', '*'],
  };
  const out: CronEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[A-Z_][A-Z0-9_]*=/i.test(line)) continue;
    if (line.startsWith('@')) {
      const [token, ...rest] = line.split(/\s+/);
      if (token === '@reboot') { out.push({ schedule: 'at boot', fields: [], command: rest.join(' ') }); continue; }
      const fields = SHORTCUTS[token];
      if (!fields || !rest.length) continue;
      out.push({ schedule: token.slice(1), fields, command: rest.join(' ') });
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 6) continue;
    const fields = parts.slice(0, 5);
    out.push({ schedule: fields.join(' '), fields, command: parts.slice(5).join(' ') });
  }
  return out;
}

function cronField(field: string, min: number, max: number): Set<number> | null {
  if (field === '*') return null;
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step < 1) continue;
    let from = min, to = max;
    if (range !== '*') {
      const [a, b] = range.split('-');
      from = Number(a);
      to = b == null ? Number(a) : Number(b);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      if (b == null && step > 1) to = max;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size ? values : null;
}

export function nextCronRun(fields: string[], now: Date): Date | null {
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;
  const minutes = cronField(minute, 0, 59);
  const hours = cronField(hour, 0, 23);
  const doms = cronField(dom, 1, 31);
  const months = cronField(month, 1, 12);
  const dows = cronField(dow, 0, 7);
  const cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 400 * 24 * 60;
  for (let step = 0; step < limit; step += 1) {
    const dowMatch = dows == null || dows.has(cursor.getDay()) || (cursor.getDay() === 0 && dows.has(7));
    const domMatch = doms == null || doms.has(cursor.getDate());
    const dayMatch = doms != null && dows != null ? domMatch || dowMatch : domMatch && dowMatch;
    if ((minutes == null || minutes.has(cursor.getMinutes())) &&
        (hours == null || hours.has(cursor.getHours())) &&
        (months == null || months.has(cursor.getMonth() + 1)) && dayMatch) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

// ---- launchd ----
export interface LaunchdPlist {
  Label?: string; Program?: string; ProgramArguments?: string[]; WorkingDirectory?: string;
  StartCalendarInterval?: CalendarSpec | CalendarSpec[]; StartInterval?: number; RunAtLoad?: boolean;
  Disabled?: boolean; StandardOutPath?: string; StandardErrorPath?: string;
}
export interface LaunchctlState { pid: number | null; lastExit: number | null }

export function parseLaunchctlList(text: string): Map<string, LaunchctlState> {
  const out = new Map<string, LaunchctlState>();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\t+|\s{2,}|\s+/);
    if (parts.length < 3) continue;
    const [pidRaw, statusRaw, ...rest] = parts;
    const label = rest.join(' ');
    if (!label || label === 'Label') continue;
    out.set(label, { pid: pidRaw === '-' ? null : Number(pidRaw), lastExit: statusRaw === '-' ? null : Number(statusRaw) });
  }
  return out;
}

const asArray = (value: CalendarSpec | CalendarSpec[] | undefined): CalendarSpec[] =>
  value == null ? [] : Array.isArray(value) ? value : [value];

export function deriveLaunchdJob(plist: LaunchdPlist, state: LaunchctlState | undefined, now: Date): JobRow | null {
  const label = plist.Label;
  if (!label) return null;
  const argv = plist.ProgramArguments?.length ? plist.ProgramArguments : plist.Program ? [plist.Program] : [];
  const { runner, model, agent } = attributeCommand(argv);
  const calendar = asArray(plist.StartCalendarInterval);
  const scheduleKind = calendar.length ? ('calendar' as const)
    : plist.StartInterval ? ('interval' as const)
    : plist.RunAtLoad ? ('manual' as const) : ('unknown' as const);
  const schedule = calendar.length ? describeCalendar(calendar)
    : plist.StartInterval ? describeInterval(plist.StartInterval)
    : plist.RunAtLoad ? 'at load' : 'on demand';
  const nextRun = scheduleKind === 'calendar' ? (nextCalendarRun(calendar, now)?.toISOString() ?? null) : null;
  const running = state?.pid != null;
  const status: JobStatus = plist.Disabled ? 'disabled'
    : state === undefined ? 'paused'
    : running ? 'running'
    : state.lastExit == null ? 'pending'
    : state.lastExit === 0 ? 'success' : 'failed';
  const projectPath = plist.WorkingDirectory ?? null;
  const outLog = plist.StandardOutPath ?? null;
  const errLog = plist.StandardErrorPath ?? null;
  return {
    id: label, name: label, source: 'launchd', schedule, scheduleKind, nextRun,
    lastRun: null, lastRunAt: null, status, lastExit: state?.lastExit ?? null,
    runner, model, agent, project: projectPath ? basename(projectPath) : null, projectPath,
    command: argv.join(' '), logPath: outLog ?? errLog,
    errLogPath: outLog != null && errLog != null && errLog !== outLog ? errLog : null,
  };
}

const SCRIPT_EXT = /\.(sh|bash|zsh|py|rb|pl|js|mjs|cjs|ts|mts|php)$/;

export function findMissingPath(argv: string[], workingDir: string | null, exists: (path: string) => boolean): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || arg.startsWith('-')) continue;
    let candidate: string | null = null;
    if (arg.startsWith('/') && (i === 0 || SCRIPT_EXT.test(arg))) candidate = arg;
    else if (i > 0 && SCRIPT_EXT.test(arg) && workingDir?.startsWith('/')) candidate = join(workingDir, arg);
    if (candidate && !exists(candidate)) return candidate;
  }
  return null;
}

function readPlist(path: string): LaunchdPlist | null {
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf-8' });
  if (result.status !== 0 || !result.stdout) return null;
  try { return JSON.parse(result.stdout) as LaunchdPlist; } catch { return null; }
}

// ---- Collection ----
export interface CollectJobsOptions {
  registry?: AutomationRow[];
  repoRoot?: string;
  agentsDir?: string;
  now?: Date;
  runLaunchctl?: () => string | null;
  runCrontab?: () => string | null;
}

function defaultLaunchctl(): string | null {
  const result = spawnSync('launchctl', ['list'], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout : null;
}
function defaultCrontab(): string | null {
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf-8' });
  return result.status === 0 ? result.stdout : null;
}

/** Match registry rows to launchd/cron jobs by suffix; heartbeat health that
 * says stale/failed outranks a launchctl exit of 0. Unmatched registry rows
 * become their own rows. */
export function mergeRegistry(jobs: JobRow[], registry: AutomationRow[]): JobRow[] {
  const claimed = new Set<string>();
  const merged = jobs.map((job) => {
    const match = registry.find((row) => job.id.endsWith(row.name) || job.command.includes(row.name));
    if (!match) return job;
    claimed.add(match.name);
    return {
      ...job,
      lastRun: match.lastRun ?? job.lastRun,
      lastRunAt: match.lastRunAt ?? job.lastRunAt,
      description: match.description ?? job.description ?? null,
      meta: match.meta ?? job.meta,
      status: match.status === 'stale' || match.status === 'failed' ? (match.status as JobStatus) : job.status,
    };
  });
  const orphans = registry.filter((row) => !claimed.has(row.name)).map<JobRow>((row) => ({
    id: `registry:${row.name}`, name: row.name, source: 'registry', schedule: row.cadence,
    scheduleKind: 'prose', nextRun: null, lastRun: row.lastRun, lastRunAt: row.lastRunAt ?? null,
    status: (row.status as JobStatus) ?? 'pending', lastExit: null, runner: row.source ?? null,
    model: null, agent: null, project: null, projectPath: null, command: '', logPath: null,
    description: row.description ?? null, meta: row.meta,
  }));
  return [...merged, ...orphans];
}

/** Templates a repo ships that are not installed on this machine yet. */
function repoTemplates(repoRoot: string, installed: Set<string>): JobRow[] {
  const dir = join(repoRoot, 'launchd');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.plist.template'))
    .map((file) => file.replace(/\.plist\.template$/, ''))
    .filter((label) => !installed.has(label))
    .map<JobRow>((label) => ({
      id: label, name: label, source: 'repo-template', schedule: 'not scheduled', scheduleKind: 'manual',
      nextRun: null, lastRun: null, lastRunAt: null, status: 'not-installed', lastExit: null,
      runner: null, model: null, agent: null, project: basename(repoRoot), projectPath: repoRoot,
      command: '', logPath: null, meta: 'ships with this repo, not installed',
    }));
}

export function collectJobs(opts: CollectJobsOptions = {}): JobsSlice {
  const now = opts.now ?? new Date();
  const agentsDir = opts.agentsDir ?? join(homedir(), 'Library', 'LaunchAgents');
  const runLaunchctl = opts.runLaunchctl ?? defaultLaunchctl;
  const runCrontab = opts.runCrontab ?? defaultCrontab;
  const jobs: JobRow[] = [];

  const state = parseLaunchctlList(runLaunchctl() ?? '');
  if (existsSync(agentsDir)) {
    for (const file of readdirSync(agentsDir)) {
      if (!file.endsWith('.plist')) continue;
      const plist = readPlist(join(agentsDir, file));
      if (!plist) continue;
      const row = deriveLaunchdJob(plist, state.get(plist.Label ?? ''), now);
      if (!row) continue;
      const argv = plist.ProgramArguments?.length ? plist.ProgramArguments : plist.Program ? [plist.Program] : [];
      row.missingPath = findMissingPath(argv, row.projectPath, existsSync);
      jobs.push(row);
    }
  }

  for (const entry of parseCrontab(runCrontab() ?? '')) {
    const argv = entry.command.split(/\s+/);
    const { runner, model, agent } = attributeCommand(argv);
    jobs.push({
      id: `cron:${entry.command}`, name: runner ? `cron: ${runner}` : 'cron job', source: 'cron',
      schedule: entry.fields.length ? entry.schedule : 'at boot',
      scheduleKind: entry.fields.length ? 'calendar' : 'manual',
      nextRun: entry.fields.length ? (nextCronRun(entry.fields, now)?.toISOString() ?? null) : null,
      lastRun: null, lastRunAt: null, status: 'pending', lastExit: null, runner, model, agent,
      project: null, projectPath: null, command: entry.command, logPath: null,
    });
  }

  const withRegistry = opts.registry?.length ? mergeRegistry(jobs, opts.registry) : jobs;
  const installed = new Set(withRegistry.map((job) => job.id));
  const templates = opts.repoRoot ? repoTemplates(opts.repoRoot, installed) : [];
  const all = [...withRegistry, ...templates];
  const sources: Record<JobSource, number> = { launchd: 0, cron: 0, registry: 0, 'repo-template': 0 };
  for (const job of all) sources[job.source] += 1;
  return { scannedAt: now.toISOString(), sources, jobs: all };
}
