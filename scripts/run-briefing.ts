#!/usr/bin/env node
/**
 * The briefing run (CHI-323 3d): the console's Run-now button and the dormant
 * launchd job both land here. Assembles a purpose-built input snapshot from the
 * hub adapter slices + a light Chronicle coverage read, spawns headless Claude
 * to digest it per skills/briefing/SKILL.md, validates the output against the
 * card contract, then merges it into briefing.json (temp + rename). A bad model
 * run can never clobber the last good briefing: it logs, exits non-zero.
 *
 * CORRECTION #3: the assembled snapshot keeps the filename `live-data.json`
 * (Varde's name) so the prompt builder AND the deterministic auto-resolve
 * re-read both find it; only its CONTENTS differ from Varde's aggregate blob.
 *
 * D7: non-spend scope. The snapshot carries jobs / safety / egress / coverage;
 * the spend cards land in phase 2 with the spend detector. Flags: --force,
 * --dry-run.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getHubAdapter } from '../server/hub/adapter.ts';
import { db } from '../server/db.ts';
import { packageRoot } from '../server/hub/paths.ts';
import type { BriefingCard, BriefingFile, BriefingStateFile } from '../server/briefing.ts';
import { autoResolve, mergeRuns } from '../server/briefing-resolve.ts';
import { extractJson, isDue, validateBriefingRun } from '../server/briefing-validate.ts';

const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const DATA_DIR = process.env.CHRONICLE_DATA_DIR || join(homedir(), '.chronicle');

function ensureDir(sub = ''): string {
  const dir = sub ? join(DATA_DIR, sub) : DATA_DIR;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** launchd PATHs are minimal, so probe the usual homes before giving up. */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CHRONICLE_CLAUDE_BIN) return env.CHRONICLE_CLAUDE_BIN;
  const onPath = spawnSync('which', ['claude'], { encoding: 'utf-8' });
  if (onPath.status === 0 && onPath.stdout.trim()) return onPath.stdout.trim();
  const candidates = [
    join(homedir(), '.claude', 'local', 'claude'),
    join(homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function resolveSkillPath(): string | null {
  const candidates = [
    join(DATA_DIR, 'skill', 'SKILL.md'),
    join(packageRoot(), 'skills', 'briefing', 'SKILL.md'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** A light coverage read so the briefing can speak to import health without the
 * whole insights engine. Never throws (a fresh machine has no DB). */
function coverage(): unknown {
  try {
    const sessions = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as unknown as { c: number }).c;
    const projects = (db.prepare('SELECT COUNT(*) AS c FROM projects').get() as unknown as { c: number }).c;
    const last = (db.prepare('SELECT MAX(ended_at) AS t FROM sessions').get() as unknown as { t: string | null }).t;
    return { sessions, projects, lastActivity: last };
  } catch {
    return null;
  }
}

/** Assemble the briefing input snapshot from the adapter slices. Keeps the
 * `live-data.json` filename (CORRECTION #3). Non-spend (D7): no spend slice. */
export function assembleSnapshot(now: Date): Record<string, unknown> {
  const a = getHubAdapter();
  return {
    generatedAt: now.toISOString(),
    jobs: a.jobs(),
    safety: a.safetyNet(),
    egress: a.egress(),
    safetyGaps: a.safetyGaps(),
    // memory grounding lands with the memory organ (1g); coverage grounding with
    // the phase-2 insights coupling. Present as an empty marker so the skill
    // knows they were considered, not forgotten.
    coverage: coverage() ?? null,
  };
}

export function buildPrompt(dir: string, now: Date): string {
  const skill = resolveSkillPath();
  return [
    skill
      ? `You are Chronicle's headless briefing run. Read ${skill} and follow it exactly.`
      : `You are Chronicle's headless briefing run. Its skill file could not be found; stop and report that.`,
    `Data directory: ${dir}`,
    `The input snapshot is ${dir}/live-data.json.`,
    `The operator's action state is ${DATA_DIR}/briefing-state.json (may be absent).`,
    `The current time is ${now.toISOString()}.`,
    `Your entire reply must be exactly one JSON object per the skill's output contract: no prose, no markdown fences.`,
  ].join('\n');
}

function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try { appendFileSync(join(ensureDir('logs'), 'briefing.log'), `${stamped}\n`); } catch { /* never kill the run */ }
}

function lastGeneratedAt(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.isExample || parsed.isDemo) return null;
    return typeof parsed.generatedAt === 'string' && parsed.generatedAt ? parsed.generatedAt : null;
  } catch { return null; }
}
function previousCards(path: string): BriefingCard[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed.isExample || parsed.isDemo || !Array.isArray(parsed.cards)) return [];
    return parsed.cards as BriefingCard[];
  } catch { return []; }
}
function readStateFile(path: string): BriefingStateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed.cards === 'object' && parsed.cards !== null) return parsed as BriefingStateFile;
  } catch { /* empty */ }
  return { version: 1, cards: {} };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const now = new Date();
  const cadence = (process.env.CHRONICLE_BRIEFING_CADENCE || 'daily').trim() || 'daily';
  const outPath = join(DATA_DIR, 'briefing.json');

  if (!force && !isDue(cadence, lastGeneratedAt(outPath), now)) {
    log(`skip cadence=${cadence} (not due; --force overrides)`);
    return 0;
  }

  // Assemble the snapshot INTO the runner cwd, keeping the live-data.json name.
  const runnerDir = ensureDir('runner');
  const snapshotPath = join(runnerDir, 'live-data.json');
  writeFileSync(snapshotPath, `${JSON.stringify(assembleSnapshot(now), null, 2)}\n`, 'utf-8');

  const prompt = buildPrompt(runnerDir, now);
  const claude = findClaude();
  // CHI-351: confine the built-in set to EXACTLY Read/Glob/Grep. `--allowedTools`
  // only auto-approves; it does NOT restrict availability (verified on CLI
  // 2.1.247: the model still had Bash/Write). `--tools` limits which built-ins
  // exist at all, so this read-only briefing run truly cannot Bash/Write. Both
  // flags together: `--tools` bounds availability, `--allowedTools` skips the
  // per-tool prompt so the headless run doesn't stall.
  const args = ['-p', prompt, '--tools', 'Read', 'Glob', 'Grep', '--allowedTools', 'Read,Glob,Grep',
    ...(process.env.CHRONICLE_BRIEFING_MODEL ? ['--model', process.env.CHRONICLE_BRIEFING_MODEL] : [])];

  if (dryRun) {
    console.log(`[dry-run] ${claude ?? 'claude (NOT FOUND)'} ${JSON.stringify(args)}`);
    return 0;
  }
  if (!claude) {
    log('fail no claude binary found (set CHRONICLE_CLAUDE_BIN or put claude on PATH)');
    return 1;
  }

  // Dedicated runner cwd so the headless transcript lands in its own lane, never
  // Chronicle's real session data. The prompt carries only absolute paths.
  const run = spawnSync(claude, args, {
    cwd: runnerDir, encoding: 'utf-8', timeout: RUN_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CHRONICLE_DATA_DIR: DATA_DIR },
  });
  if (run.error || run.status !== 0) {
    log(`fail claude exited ${run.status ?? 'signal'}: ${(run.stderr || run.error?.message || '').trim().slice(0, 400)}`);
    return 1;
  }

  let cards: ReturnType<typeof validateBriefingRun>;
  try { cards = validateBriefingRun(extractJson(run.stdout), now); }
  catch (err) { log(`fail ${err instanceof Error ? err.message : String(err)}`); return 1; }
  for (const d of cards.dropped) log(`drop card[${d.index}]: ${d.errors.join('; ')}`);
  if (cards.errors.length) { log(`fail ${cards.errors.join('; ')}`); return 1; }

  const statePath = join(DATA_DIR, 'briefing-state.json');
  const state = readStateFile(statePath);
  const file: BriefingFile = {
    version: 1, generatedAt: now.toISOString(), cadence,
    cards: mergeRuns(previousCards(outPath), cards.cards, state, now),
  };

  // Deterministic auto-resolve against the snapshot this run just assembled.
  let resolvedIds: string[] = [];
  try {
    const live = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    const result = autoResolve(file, state, live, now);
    resolvedIds = result.resolvedIds;
    if (resolvedIds.length) {
      const stateTmp = `${statePath}.run-tmp`;
      writeFileSync(stateTmp, `${JSON.stringify(result.state, null, 2)}\n`, 'utf-8');
      renameSync(stateTmp, statePath);
      for (const id of resolvedIds) log(`resolved ${id} (condition no longer fires)`);
    }
  } catch (err) {
    log(`skip auto-resolve (${err instanceof Error ? err.message : String(err)})`);
  }

  ensureDir();
  const tmp = `${outPath}.run-tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf-8');
  renameSync(tmp, outPath);
  log(`ok cards=${cards.cards.length} ledger=${file.cards.length} dropped=${cards.dropped.length} resolved=${resolvedIds.length} cadence=${cadence} needsYou=${cards.cards.filter((c) => c.needsYou).length}`);
  return 0;
}

if (import.meta.main) process.exit(main());
