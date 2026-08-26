/**
 * Log access for the Jobs drill-down (ported from Varde, CHI-323 3c).
 *
 * The boundary: the browser sends a job ID, never a path. The only files this
 * module opens are the log paths the served jobs slice itself declares on that
 * job's row (StandardOutPath / StandardErrorPath from its own plist), so the
 * reachable set is exactly what the jobs collector already reported. Read-only,
 * loopback-only, last ~100 lines, tail-capped so a runaway log cannot be slurped
 * whole into memory.
 */
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { packageRoot } from './hub/paths.ts';

export const TAIL_LINES = 100;
const TAIL_BYTES = 64 * 1024;

export interface LogTail {
  path: string;
  exists: boolean;
  lines: string[];
  truncated: boolean;
}

export interface JobLogView {
  id: string;
  stdout: LogTail | null;
  stderr: LogTail | null;
}

interface JobLike { id?: unknown; logPath?: unknown; errLogPath?: unknown }

/** Relative declared paths resolve against the package root (the committed demo
 * fixture logs). Real launchd plists carry absolute paths. */
function resolveDeclared(path: string): string {
  return isAbsolute(path) ? path : resolve(packageRoot(), path);
}

export function readLogTail(declaredPath: string): LogTail {
  const real = resolveDeclared(declaredPath);
  let fd: number;
  try {
    fd = openSync(real, 'r');
  } catch {
    return { path: declaredPath, exists: false, lines: [], truncated: false };
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf-8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    // eslint-disable-next-line no-control-regex
    text = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); // strip ANSI SGR/cursor noise
    const all = text.split('\n');
    if (all.at(-1) === '') all.pop();
    const lines = all.slice(-TAIL_LINES);
    return { path: declaredPath, exists: true, lines, truncated: start > 0 || all.length > TAIL_LINES };
  } finally {
    closeSync(fd);
  }
}

/** Find the job in the slice, read the tails of exactly the paths it declares.
 * Unknown ID -> null. */
export function jobLogView(jobs: JobLike[], id: string): JobLogView | null {
  const job = jobs.find((row) => row.id === id);
  if (!job) return null;
  const out = typeof job.logPath === 'string' && job.logPath ? job.logPath : null;
  const err = typeof job.errLogPath === 'string' && job.errLogPath ? job.errLogPath : null;
  return { id, stdout: out ? readLogTail(out) : null, stderr: err && err !== out ? readLogTail(err) : null };
}
