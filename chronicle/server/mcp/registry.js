import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { db } from '../db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS mcp_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',  -- stdio | http | sse
  command TEXT, args TEXT, env TEXT,        -- stdio (args/env JSON)
  url TEXT, headers TEXT,                   -- http/sse (headers JSON)
  enabled INTEGER NOT NULL DEFAULT 1,
  origin TEXT,                              -- which tool config it came from
  imported_at TEXT DEFAULT (datetime('now'))
);`);

const HOME = os.homedir();

// ---- Source config scanners (FR-MCP-2) ----

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function normalizeEntry(name, cfg, origin) {
  const transport = cfg.type === 'http' || cfg.url ? (cfg.type === 'sse' ? 'sse' : 'http') : 'stdio';
  return {
    name,
    transport: cfg.command ? 'stdio' : transport,
    command: cfg.command ?? null,
    args: JSON.stringify(cfg.args ?? []),
    env: JSON.stringify(cfg.env ?? {}),
    url: cfg.url ?? null,
    headers: JSON.stringify(cfg.headers ?? {}),
    origin,
  };
}

// Minimal TOML reader for Codex's [mcp_servers.<name>] sections.
function readCodexToml(p) {
  try {
    const out = {};
    let current = null;
    for (let line of fs.readFileSync(p, 'utf8').split('\n')) {
      line = line.trim();
      const sec = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
      if (sec) { current = {}; out[sec[1].replace(/"/g, '')] = current; continue; }
      if (line.startsWith('[')) { current = null; continue; }
      if (!current) continue;
      const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
      if (!kv) continue;
      const [, key, raw] = kv;
      try { current[key] = JSON.parse(raw.replace(/'/g, '"')); } catch { current[key] = raw.replace(/^["']|["']$/g, ''); }
    }
    return out;
  } catch { return {}; }
}

export function scanMcpConfigs() {
  const sources = [];
  const claude = readJson(path.join(HOME, '.claude.json'));
  if (claude?.mcpServers) sources.push({ origin: 'claude-code (user)', file: path.join(HOME, '.claude.json'), servers: claude.mcpServers });
  // Claude project-level .mcp.json for imported projects
  for (const p of db.prepare('SELECT path FROM projects').all()) {
    const cfg = readJson(path.join(p.path, '.mcp.json'));
    if (cfg?.mcpServers) sources.push({ origin: `claude-code (project ${path.basename(p.path)})`, file: path.join(p.path, '.mcp.json'), servers: cfg.mcpServers });
  }
  const cursor = readJson(path.join(HOME, '.cursor', 'mcp.json'));
  if (cursor?.mcpServers) sources.push({ origin: 'cursor', file: path.join(HOME, '.cursor', 'mcp.json'), servers: cursor.mcpServers });
  const gemini = readJson(path.join(HOME, '.gemini', 'settings.json'));
  if (gemini?.mcpServers) sources.push({ origin: 'gemini-cli', file: path.join(HOME, '.gemini', 'settings.json'), servers: gemini.mcpServers });
  const codexToml = path.join(HOME, '.codex', 'config.toml');
  if (fs.existsSync(codexToml)) {
    const servers = readCodexToml(codexToml);
    if (Object.keys(servers).length) sources.push({ origin: 'codex', file: codexToml, servers });
  }
  return sources;
}

// Smart merge classification (FR-MCP-3): New / Updated / Conflict / Unchanged
export function classifyScan() {
  const existing = new Map(listServices().map((s) => [s.name, s]));
  const items = [];
  for (const src of scanMcpConfigs()) {
    for (const [name, cfg] of Object.entries(src.servers)) {
      const entry = normalizeEntry(name, cfg, src.origin);
      const cur = existing.get(name);
      let status = 'new';
      if (cur) {
        const same = cur.command === entry.command && cur.args === entry.args &&
          cur.env === entry.env && cur.url === entry.url && cur.headers === entry.headers;
        if (same) status = 'unchanged';
        else status = cur.origin === entry.origin ? 'updated' : 'conflict';
      }
      items.push({ ...entry, status, file: src.file, current: cur ?? null });
    }
  }
  return items;
}

// Auto-backup source files before takeover (FR-MCP-3/12); keep last 5 sets.
export function backupSources() {
  const backupRoot = path.join(HOME, '.chronicle', 'backups', 'mcp');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(backupRoot, stamp);
  fs.mkdirSync(dest, { recursive: true });
  const seen = new Set();
  for (const src of scanMcpConfigs()) {
    if (seen.has(src.file) || !fs.existsSync(src.file)) continue;
    seen.add(src.file);
    fs.copyFileSync(src.file, path.join(dest, src.file.replaceAll('/', '_')));
  }
  const all = fs.readdirSync(backupRoot).sort();
  while (all.length > 5) fs.rmSync(path.join(backupRoot, all.shift()), { recursive: true, force: true });
  return dest;
}

// ---- Registry CRUD (FR-MCP-4) ----

export function listServices() {
  return db.prepare('SELECT * FROM mcp_services ORDER BY name').all();
}

export function upsertService(entry) {
  db.prepare(`INSERT INTO mcp_services (name, transport, command, args, env, url, headers, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET transport=excluded.transport, command=excluded.command,
      args=excluded.args, env=excluded.env, url=excluded.url, headers=excluded.headers, origin=excluded.origin`)
    .run(entry.name, entry.transport, entry.command, entry.args, entry.env, entry.url, entry.headers, entry.origin ?? 'manual');
}

export function setServiceEnabled(id, enabled) {
  db.prepare('UPDATE mcp_services SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function deleteService(id) {
  db.prepare('DELETE FROM mcp_services WHERE id = ?').run(id);
}

// Mask secret-looking values for display (FR-MCP-5)
export function maskService(s) {
  const mask = (v) => (typeof v === 'string' && v.length > 6 ? v.slice(0, 4) + '…' + '*'.repeat(6) : '****');
  const env = JSON.parse(s.env || '{}');
  const headers = JSON.parse(s.headers || '{}');
  for (const k of Object.keys(env)) if (/token|key|secret|pass|auth/i.test(k) || String(env[k]).length > 20) env[k] = mask(env[k]);
  for (const k of Object.keys(headers)) headers[k] = mask(headers[k]);
  return { ...s, env: JSON.stringify(env), headers: JSON.stringify(headers) };
}
