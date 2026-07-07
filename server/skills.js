import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { db } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  central_path TEXT NOT NULL,
  description TEXT,
  origin_path TEXT,
  origin_source TEXT,
  tags TEXT DEFAULT '[]',
  rating INTEGER DEFAULT 0,
  imported_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS skill_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL REFERENCES skills(id),
  trigger TEXT NOT NULL,        -- imported | fs_change | upstream_sync | restore
  ts TEXT DEFAULT (datetime('now')),
  hash TEXT NOT NULL,
  size INTEGER,
  path TEXT NOT NULL
);`);
try { db.exec("ALTER TABLE skills ADD COLUMN origin_repo TEXT"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN origin_sha TEXT"); } catch {}

const HOME = os.homedir();
export const CENTRAL_SKILLS = path.join(HOME, '.chronicle', 'skills');

// Scan sources (FR-SK-2): standard tool dirs + AGENTS.md convention dir.
const SCAN_SOURCES = [
  { source: 'claude-code (user)', dir: path.join(HOME, '.claude', 'skills') },
  { source: 'agents-convention', dir: path.join(HOME, '.agents', 'skills') },
  { source: 'cursor', dir: path.join(HOME, '.cursor', 'skills') },
  { source: 'codex', dir: path.join(HOME, '.codex', 'skills') },
  { source: 'gemini-cli', dir: path.join(HOME, '.gemini', 'skills') },
];

// Symlink distribution targets (FR-SK-1) — only ever *add* links; never
// overwrite a real directory (non-destructive subset of Chronicle's takeover).
const DISTRIBUTE_TARGETS = [
  { tool: 'claude-code', dir: path.join(HOME, '.claude', 'skills') },
  { tool: 'cursor', dir: path.join(HOME, '.cursor', 'skills') },
  { tool: 'codex', dir: path.join(HOME, '.codex', 'skills') },
  { tool: 'gemini-cli', dir: path.join(HOME, '.gemini', 'skills') },
];

function readSkillMeta(dir) {
  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;
  try {
    const text = fs.readFileSync(skillMd, 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    let name = path.basename(dir), description = '';
    if (fm) {
      const lines = fm[1].split('\n');
      let inDesc = false;
      const descParts = [];
      for (const line of lines) {
        const key = line.match(/^([\w-]+):\s*(.*)$/);
        if (key) {
          inDesc = key[1] === 'description';
          if (key[1] === 'name' && key[2]) name = key[2].trim();
          if (inDesc && key[2] && !/^[>|][+-]?$/.test(key[2].trim())) descParts.push(key[2].trim());
        } else if (inDesc && /^\s+\S/.test(line)) {
          descParts.push(line.trim());
        } else if (line.trim() && !/^\s/.test(line)) {
          inDesc = false;
        }
      }
      description = descParts.join(' ').replace(/\s+/g, ' ').slice(0, 300);
    }
    return { name, description };
  } catch { return null; }
}

// Four-tier classification (FR-SK-3): importable / managed / duplicate / broken
export function scanSkills() {
  const central = new Map(listSkills().map((s) => [s.name, s]));
  const groups = [];
  for (const src of SCAN_SOURCES) {
    if (!fs.existsSync(src.dir)) continue;
    const items = [];
    for (const d of fs.readdirSync(src.dir, { withFileTypes: true })) {
      const full = path.join(src.dir, d.name);
      let st = null;
      try { st = fs.statSync(full); } catch {}
      const isLink = fs.lstatSync(full).isSymbolicLink();
      if (!st || !st.isDirectory()) {
        if (isLink) items.push({ dirName: d.name, path: full, status: 'broken', reason: 'dangling symlink' });
        continue;
      }
      const linkTarget = isLink ? fs.realpathSync(full) : null;
      if (linkTarget?.startsWith(CENTRAL_SKILLS)) {
        items.push({ dirName: d.name, path: full, status: 'managed', name: path.basename(linkTarget) });
        continue;
      }
      const meta = readSkillMeta(full);
      if (!meta) { items.push({ dirName: d.name, path: full, status: 'broken', reason: 'no SKILL.md' }); continue; }
      items.push({
        dirName: d.name, path: full, ...meta,
        status: central.has(meta.name) ? 'duplicate' : 'importable',
      });
    }
    if (items.length) groups.push({ ...src, items });
  }
  return groups;
}

// Import = copy into central storage; originals untouched (FR-SK-9 disambiguation).
export function importSkill(sourcePath, origin) {
  const meta = readSkillMeta(sourcePath);
  if (!meta) throw new Error('No valid SKILL.md at ' + sourcePath);
  fs.mkdirSync(CENTRAL_SKILLS, { recursive: true });
  let name = meta.name.replace(/[^\w.-]+/g, '-');
  let n = 2;
  while (db.prepare('SELECT 1 FROM skills WHERE name = ?').get(name)) name = `${meta.name}-${n++}`;
  const dest = path.join(CENTRAL_SKILLS, name);
  fs.cpSync(sourcePath, dest, { recursive: true, dereference: true });
  db.prepare(`INSERT INTO skills (name, central_path, description, origin_path, origin_source)
              VALUES (?, ?, ?, ?, ?)`).run(name, dest, meta.description, sourcePath, origin ?? null);
  return db.prepare('SELECT * FROM skills WHERE name = ?').get(name);
}

export function listSkills() {
  return db.prepare('SELECT * FROM skills ORDER BY name').all().map((s) => ({
    ...s,
    links: linkStatus(s),
    exists: fs.existsSync(s.central_path),
  }));
}

function linkStatus(skill) {
  return DISTRIBUTE_TARGETS.map((t) => {
    const target = path.join(t.dir, skill.name);
    let status = 'none';
    try {
      const l = fs.lstatSync(target);
      if (l.isSymbolicLink()) {
        status = fs.realpathSync(target) === fs.realpathSync(skill.central_path) ? 'linked' : 'other-link';
      } else status = 'real-dir';
    } catch {}
    return { tool: t.tool, dir: t.dir, status, toolDirExists: fs.existsSync(t.dir) };
  });
}

// Distribute via symlink (FR-SK-1). Refuses to replace real dirs or foreign links.
export function linkSkill(skillId, tool) {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  const target = DISTRIBUTE_TARGETS.find((t) => t.tool === tool);
  if (!skill || !target) throw new Error('Unknown skill or tool');
  fs.mkdirSync(target.dir, { recursive: true });
  const linkPath = path.join(target.dir, skill.name);
  if (fs.existsSync(linkPath) || isLink(linkPath)) {
    if (isLink(linkPath) && fs.realpathSync(linkPath) === fs.realpathSync(skill.central_path)) return; // already linked
    throw new Error(`${linkPath} already exists — not overwriting`);
  }
  // Windows: junctions work without admin rights; 'dir' symlinks don't (FR-SK-1)
  fs.symlinkSync(skill.central_path, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

export function unlinkSkill(skillId, tool) {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  const target = DISTRIBUTE_TARGETS.find((t) => t.tool === tool);
  if (!skill || !target) throw new Error('Unknown skill or tool');
  const linkPath = path.join(target.dir, skill.name);
  // Only remove if it is OUR symlink — never a real directory.
  if (isLink(linkPath) && fs.realpathSync(linkPath) === fs.realpathSync(skill.central_path)) {
    fs.unlinkSync(linkPath);
  } else if (fs.existsSync(linkPath)) {
    throw new Error(`${linkPath} is not a Chronicle-managed symlink — refusing to remove`);
  }
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export function updateSkillMeta(id, { tags, rating }) {
  if (tags !== undefined) db.prepare('UPDATE skills SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
  if (rating !== undefined) db.prepare('UPDATE skills SET rating = ? WHERE id = ?').run(rating, id);
}

export function skillContent(id) {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
  if (!skill) return null;
  const md = path.join(skill.central_path, 'SKILL.md');
  return {
    ...skill,
    content: fs.existsSync(md) ? fs.readFileSync(md, 'utf8').slice(0, 20000) : null,
    files: fs.existsSync(skill.central_path) ? fs.readdirSync(skill.central_path) : [],
  };
}

// ---- Version history & snapshots (FR-SK-13) ----

const SNAPSHOT_ROOT = path.join(HOME, '.chronicle', 'snapshots');
const MAX_ROLLING = 50; // non-imported snapshots per skill

function dirHash(dir) {
  const h = crypto.createHash('sha256');
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { h.update(e.name); walk(full); }
      else { h.update(e.name); h.update(fs.readFileSync(full)); }
    }
  })(dir);
  return h.digest('hex').slice(0, 16);
}

function dirSize(dir) {
  let total = 0;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      e.isDirectory() ? walk(full) : (total += fs.statSync(full).size);
    }
  })(dir);
  return total;
}

export function takeSnapshot(skillId, trigger) {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  if (!skill || !fs.existsSync(skill.central_path)) return null;
  const hash = dirHash(skill.central_path);
  // identical-hash dedup
  const last = db.prepare('SELECT hash FROM skill_snapshots WHERE skill_id = ? ORDER BY id DESC LIMIT 1').get(skillId);
  if (last?.hash === hash && trigger !== 'imported') return null;
  const dest = path.join(SNAPSHOT_ROOT, skill.name, `${Date.now()}-${trigger}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(skill.central_path, dest, { recursive: true });
  db.prepare('INSERT INTO skill_snapshots (skill_id, trigger, hash, size, path) VALUES (?, ?, ?, ?, ?)')
    .run(skillId, trigger, hash, dirSize(dest), dest);
  // rolling cleanup: keep 'imported' snapshots forever, cap the rest
  const rolling = db.prepare(
    "SELECT id, path FROM skill_snapshots WHERE skill_id = ? AND trigger != 'imported' ORDER BY id DESC").all(skillId);
  for (const old of rolling.slice(MAX_ROLLING)) {
    fs.rmSync(old.path, { recursive: true, force: true });
    db.prepare('DELETE FROM skill_snapshots WHERE id = ?').run(old.id);
  }
  return hash;
}

export function listSnapshots(skillId) {
  return db.prepare('SELECT * FROM skill_snapshots WHERE skill_id = ? ORDER BY id DESC').all(skillId);
}

export function restoreSnapshot(skillId, snapshotId) {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  const snap = db.prepare('SELECT * FROM skill_snapshots WHERE id = ? AND skill_id = ?').get(snapshotId, skillId);
  if (!skill || !snap || !fs.existsSync(snap.path)) throw new Error('Snapshot not found');
  takeSnapshot(skillId, 'restore'); // auto-snapshot current state first
  fs.rmSync(skill.central_path, { recursive: true, force: true });
  fs.cpSync(snap.path, skill.central_path, { recursive: true });
  // symlinks point at central_path, so they keep working untouched
  return { ok: true };
}

// fs_change watcher: 500ms debounce per skill (FR-SK-13)
const watchState = globalThis.__chronicleSkillWatch ??= { started: false, timers: new Map() };
export function startSkillWatcher() {
  if (watchState.started || !fs.existsSync(CENTRAL_SKILLS)) return;
  watchState.started = true;
  try {
    fs.watch(CENTRAL_SKILLS, { recursive: true }, (event, file) => {
      const skillName = String(file || '').split(path.sep)[0];
      if (!skillName) return;
      clearTimeout(watchState.timers.get(skillName));
      watchState.timers.set(skillName, setTimeout(() => {
        const skill = db.prepare('SELECT id FROM skills WHERE name = ?').get(skillName);
        if (skill) { try { takeSnapshot(skill.id, 'fs_change'); } catch {} }
      }, 500));
    });
  } catch { watchState.started = false; }
}

// ---- GitHub import (FR-SK-8): shallow clone → scan → import, SHA recorded ----

export function importFromGithub(repoUrl, branch = 'main', subpath = '') {
  if (!/^https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+/.test(repoUrl)) throw new Error('Public HTTPS repo URL required');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-gh-'));
  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', branch, repoUrl, tmp],
      { stdio: 'pipe', timeout: 120000 });
    const sha = execFileSync('git', ['-C', tmp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const scanRoot = path.join(tmp, subpath);
    if (!fs.existsSync(scanRoot)) throw new Error(`Subpath '${subpath}' not found in repo`);
    // find all dirs containing SKILL.md
    const found = [];
    (function walk(d, depth) {
      if (depth > 5) return;
      if (fs.existsSync(path.join(d, 'SKILL.md'))) { found.push(d); return; }
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') walk(path.join(d, e.name), depth + 1);
      }
    })(scanRoot, 0);
    const imported = [];
    for (const dir of found) {
      const skill = importSkill(dir, `github:${repoUrl}`);
      db.prepare('UPDATE skills SET origin_repo = ?, origin_sha = ? WHERE id = ?').run(`${repoUrl}#${branch}`, sha, skill.id);
      takeSnapshot(skill.id, 'imported');
      imported.push(skill.name);
    }
    return { ok: true, sha: sha.slice(0, 10), found: found.length, imported };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Check Upstream: compare recorded SHA against the remote tip (git ls-remote, no clone)
export function checkUpstream(skillId) {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId);
  if (!skill?.origin_repo) throw new Error('Skill was not imported from GitHub');
  const [url, branch = 'main'] = skill.origin_repo.split('#');
  const out = execFileSync('git', ['ls-remote', url, `refs/heads/${branch}`], { encoding: 'utf8', timeout: 30000 });
  const latest = out.split('\t')[0]?.trim();
  return {
    current: skill.origin_sha?.slice(0, 10),
    latest: latest?.slice(0, 10),
    upToDate: latest === skill.origin_sha,
  };
}

export function deleteSkill(id, removeFiles = false) {
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(id);
  if (!skill) return;
  // Remove our symlinks first so tools don't dangle
  for (const t of DISTRIBUTE_TARGETS) {
    try { unlinkSkill(id, t.tool); } catch {}
  }
  if (removeFiles && skill.central_path.startsWith(CENTRAL_SKILLS)) {
    fs.rmSync(skill.central_path, { recursive: true, force: true });
  }
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
}
