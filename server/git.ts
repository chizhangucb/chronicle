import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RepoInfo {
  isRepo: boolean;
  commitCount?: number;
  branch?: string | null;
}

export interface Commit {
  hash: string;
  date: string;
  subject: string;
  beforeHistory?: boolean;
}

export interface FileAtResult {
  content: string | null;
  previous: string | null;
  prevCommit: string | null;
  changedInCommit: boolean;
}

// All operations are read-only against the project's git repo.
function git(repo: string, args: string[], opts: Record<string, unknown> = {}): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }) as unknown as string;
}

export function isGitRepo(dir: string | null | undefined): boolean {
  try {
    return !!dir && fs.existsSync(dir) &&
      git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch { return false; }
}

export function repoInfo(dir: string | null | undefined): RepoInfo {
  if (!isGitRepo(dir)) return { isRepo: false };
  try {
    const count = parseInt(git(dir as string, ['rev-list', '--count', 'HEAD']).trim(), 10);
    const branch = git(dir as string, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    return { isRepo: true, commitCount: count, branch };
  } catch {
    return { isRepo: true, commitCount: 0, branch: null };
  }
}

// Commits in [from, to] range (ISO strings), oldest first, for timeline ticks.
export function commitsBetween(dir: string, from: string, to: string): Commit[] {
  if (!isGitRepo(dir)) return [];
  try {
    const pad = 10 * 60 * 1000; // 10min padding either side
    const since = new Date(new Date(from).getTime() - pad).toISOString();
    const until = new Date(new Date(to).getTime() + pad).toISOString();
    const out = git(dir, ['log', '--all', `--since=${since}`, `--until=${until}`,
      '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%s']);
    if (!out.trim()) return [];
    return out.trim().split('\n').map((l): Commit => {
      const [hash, date, ...subject] = l.split('\t');
      return { hash, date, subject: subject.join('\t') };
    }).reverse();
  } catch { return []; }
}

// Nearest commit at-or-before ts. Falls back to the oldest commit.
export function commitAt(dir: string, ts: string): Commit | null {
  if (!isGitRepo(dir)) return null;
  try {
    const hash = git(dir, ['rev-list', '-1', `--before=${ts}`, '--all']).trim();
    if (hash) return describeCommit(dir, hash);
    const oldest = git(dir, ['rev-list', '--max-parents=0', '--all']).trim().split('\n')[0];
    return oldest ? { ...describeCommit(dir, oldest), beforeHistory: true } : null;
  } catch { return null; }
}

function describeCommit(dir: string, hash: string): Commit {
  const out = git(dir, ['show', '-s', '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%s', hash]);
  const [h, date, ...subject] = out.split('\t');
  return { hash: h, date, subject: subject.join('\t') };
}

export function treeAt(dir: string, commit: string): string[] {
  const out = git(dir, ['ls-tree', '-r', '--name-only', commit]);
  return out.trim() ? out.trim().split('\n') : [];
}

// File content at commit, plus the previous version (for diff view).
export function fileAt(dir: string, commit: string, filePath: string): FileAtResult {
  let content: string | null = null;
  let previous: string | null = null;
  let prevCommit: string | null = null;
  try { content = git(dir, ['show', `${commit}:${filePath}`]); } catch {}
  try {
    prevCommit = git(dir, ['rev-list', '-1', `${commit}~1`, '--', filePath]).trim() || null;
    if (prevCommit) previous = git(dir, ['show', `${prevCommit}:${filePath}`]);
  } catch {}
  // Files changed in this commit (to badge the tree / auto-highlight)
  let changed: string[] = [];
  try {
    changed = git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', commit]).trim().split('\n').filter(Boolean);
  } catch {}
  return { content, previous, prevCommit, changedInCommit: changed.includes(filePath) };
}

export function changedFiles(dir: string, commit: string): string[] {
  try {
    return git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', commit]).trim().split('\n').filter(Boolean);
  } catch { return []; }
}

export function assertSafeRepoPath(dir: string): string {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) throw new Error('Path does not exist');
  return resolved;
}
