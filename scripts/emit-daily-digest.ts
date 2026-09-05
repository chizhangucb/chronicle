#!/usr/bin/env node
/**
 * CHI-398: the satellite daily-digest emitter. Writes one small JSON artifact
 * per run into the hub's `records/spool/chronicle/` so this repo's daily
 * signal folds into the hub's ONE daily maintenance digest instead of Chi
 * watching Chronicle as a separate channel (governance/satellite-repos.md
 * "Daily-report spool", hub scripts/satellite_digest.py).
 *
 * Boundary (satellite-repos.md "Boundary invariants"): this repo writes ONLY
 * into its own spool path and never imports hub code -- the ~15-line writer
 * below is a deliberate duplicate of `satellite_digest.write_artifact`, not a
 * shared dependency. It also reads nothing from the hub.
 *
 * Every signal here is cheap, local-only (no network, no auth, no secrets)
 * and degrades gracefully: a failing signal is skipped, never thrown, so a
 * bad git state or a missing DB can never sink the daily job this is folded
 * into.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = 'chronicle';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- hub path resolution (must match hub scripts/satellite_digest.py's own
// convention EXACTLY): AIOS_HUB env if set & non-empty, else ~/chizhang-2.
// Never hardcode an absolute hub path. ----
export function resolveHub(): string {
  const raw = process.env.AIOS_HUB;
  if (raw && raw.trim()) return raw.trim();
  return join(homedir(), 'chizhang-2');
}

/** Local YYYY-MM-DD (matches the hub artifact's `date` field convention). */
function localDate(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Duplicate of the hub's `satellite_digest.write_artifact` (Python), kept
 * in-repo per the no-cross-boundary-import rule. Atomic write: tmp + rename. */
function writeArtifact(
  hub: string,
  repo: string,
  dateStr: string,
  opts: { needsYou?: string[]; autoDone?: Record<string, number>; health?: string[] },
): string {
  const dir = join(hub, 'records', 'spool', repo);
  mkdirSync(dir, { recursive: true });
  const payload = {
    repo,
    date: dateStr,
    needs_you: opts.needsYou ?? [],
    auto_done: opts.autoDone ?? {},
    health: opts.health ?? [],
  };
  const path = join(dir, `${dateStr}-${randomBytes(4).toString('hex')}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
  return path;
}

/** Run git in the repo; null on any failure (never throws). */
function git(args: string[]): string | null {
  try {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8', timeout: 10_000 });
    if (r.status !== 0 || r.error) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

function countLines(s: string | null): number | null {
  if (s === null) return null;
  const trimmed = s.trim();
  return trimmed ? trimmed.split('\n').length : 0;
}

/** Cheap, best-effort local signals. Every field is independently optional --
 * one failing never blocks the others. */
function gitSignals(): { branch: string | null; uncommitted: number | null; commits24h: number | null; unpushed: number | null; upstream: string | null } {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const uncommitted = countLines(git(['status', '--porcelain']));
  const commits24h = countLines(git(['log', '--since=24 hours ago', '--pretty=format:%H']));
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const unpushed = upstream ? countLines(git(['rev-list', `${upstream}..HEAD`, '--pretty=format:%H'])) : null;
  return { branch, uncommitted, commits24h, unpushed, upstream };
}

/** Optional repo-native signal: sessions Chronicle recorded today, read
 * straight off ~/.chronicle/chronicle.db. Cheap (one COUNT query), never
 * imports server/db.ts (that module has side effects: migrations, etc.) --
 * opened readonly, best-effort, skipped entirely on any failure. */
function sessionsToday(now: Date): number | null {
  const dataDir = process.env.CHRONICLE_DATA_DIR || join(homedir(), '.chronicle');
  const dbPath = join(dataDir, 'chronicle.db');
  if (!existsSync(dbPath)) return null;
  try {
    // A locked/corrupt db degrades this one signal, never the whole emitter.
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const day = localDate(now);
      const row = db
        .prepare("SELECT COUNT(*) AS c FROM sessions WHERE substr(started_at, 1, 10) = ?")
        .get(day) as { c: number } | undefined;
      return typeof row?.c === 'number' ? row.c : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export function buildPayload(now: Date): { needsYou: string[]; autoDone: Record<string, number>; health: string[] } {
  const health: string[] = [];
  const autoDone: Record<string, number> = {};

  const { branch, uncommitted, commits24h, unpushed, upstream } = gitSignals();

  if (branch !== null && uncommitted !== null) {
    health.push(`branch ${branch}, ${uncommitted} uncommitted`);
  } else if (branch !== null) {
    health.push(`branch ${branch}`);
  }

  if (commits24h !== null) {
    autoDone.commits = commits24h;
    health.push(`${commits24h} commits/24h`);
  }

  if (upstream !== null && unpushed !== null) {
    health.push(`${unpushed} unpushed vs ${upstream}`);
  }

  const sessions = sessionsToday(now);
  if (sessions !== null) {
    health.push(`${sessions} sessions today`);
  }

  // The hub validator + governance both require health to be non-empty so
  // the section is never blank -- a floor line if every signal above failed.
  if (health.length === 0) health.push('no signals available');

  // FLOOR-class only, genuinely rare. This emitter has no floor-worthy
  // condition to detect yet, so it never fabricates one.
  const needsYou: string[] = [];

  return { needsYou, autoDone, health };
}

export function main(now: Date = new Date()): number {
  const hub = resolveHub();
  const dateStr = localDate(now);
  const { needsYou, autoDone, health } = buildPayload(now);
  try {
    const path = writeArtifact(hub, REPO, dateStr, { needsYou, autoDone, health });
    console.log(`chronicle daily digest written: ${path}`);
    return 0;
  } catch (err) {
    // Never crash the daily job this is folded into -- log and move on.
    console.error(`chronicle daily digest: failed to write artifact: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(main());
