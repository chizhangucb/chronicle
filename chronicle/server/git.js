import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// All operations are read-only against the project's git repo.
function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

export function isGitRepo(dir) {
  try {
    return !!dir && fs.existsSync(dir) &&
      git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch { return false; }
}

export function repoInfo(dir) {
  if (!isGitRepo(dir)) return { isRepo: false };
  try {
    const count = parseInt(git(dir, ['rev-list', '--count', 'HEAD']).trim(), 10);
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    return { isRepo: true, commitCount: count, branch };
  } catch {
    return { isRepo: true, commitCount: 0, branch: null };
  }
}

// Commits in [from, to] range (ISO strings), oldest first, for timeline ticks.
export function commitsBetween(dir, from, to) {
  if (!isGitRepo(dir)) return [];
  try {
    const pad = 10 * 60 * 1000; // 10min padding either side
    const since = new Date(new Date(from).getTime() - pad).toISOString();
    const until = new Date(new Date(to).getTime() + pad).toISOString();
    const out = git(dir, ['log', '--all', `--since=${since}`, `--until=${until}`,
      '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%s']);
    if (!out.trim()) return [];
    return out.trim().split('\n').map((l) => {
      const [hash, date, ...subject] = l.split('\t');
      return { hash, date, subject: subject.join('\t') };
    }).reverse();
  } catch { return []; }
}

// Nearest commit at-or-before ts. Falls back to the oldest commit.
export function commitAt(dir, ts) {
  if (!isGitRepo(dir)) return null;
  try {
    const hash = git(dir, ['rev-list', '-1', `--before=${ts}`, '--all']).trim();
    if (hash) return describeCommit(dir, hash);
    const oldest = git(dir, ['rev-list', '--max-parents=0', '--all']).trim().split('\n')[0];
    return oldest ? { ...describeCommit(dir, oldest), beforeHistory: true } : null;
  } catch { return null; }
}

function describeCommit(dir, hash) {
  const out = git(dir, ['show', '-s', '--date=iso-strict', '--pretty=format:%H%x09%ad%x09%s', hash]);
  const [h, date, ...subject] = out.split('\t');
  return { hash: h, date, subject: subject.join('\t') };
}

export function treeAt(dir, commit) {
  const out = git(dir, ['ls-tree', '-r', '--name-only', commit]);
  return out.trim() ? out.trim().split('\n') : [];
}

// File content at commit, plus the previous version (for diff view).
export function fileAt(dir, commit, filePath) {
  let content = null;
  let previous = null;
  let prevCommit = null;
  try { content = git(dir, ['show', `${commit}:${filePath}`]); } catch {}
  try {
    prevCommit = git(dir, ['rev-list', '-1', `${commit}~1`, '--', filePath]).trim() || null;
    if (prevCommit) previous = git(dir, ['show', `${prevCommit}:${filePath}`]);
  } catch {}
  // Files changed in this commit (to badge the tree / auto-highlight)
  let changed = [];
  try {
    changed = git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', commit]).trim().split('\n').filter(Boolean);
  } catch {}
  return { content, previous, prevCommit, changedInCommit: changed.includes(filePath) };
}

export function changedFiles(dir, commit) {
  try {
    return git(dir, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', commit]).trim().split('\n').filter(Boolean);
  } catch { return []; }
}

export function assertSafeRepoPath(dir) {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) throw new Error('Path does not exist');
  return resolved;
}
