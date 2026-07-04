import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
);`);

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
  fs.symlinkSync(skill.central_path, linkPath, 'dir');
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
