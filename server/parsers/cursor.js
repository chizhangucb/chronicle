import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function cursorUserDir() {
  if (process.env.CHRONICLE_CURSOR_DIR) return process.env.CHRONICLE_CURSOR_DIR;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  return path.join(home, '.config', 'Cursor', 'User');
}

// Read-only guarantee: copy the SQLite file (+WAL) to temp before opening.
function openSnapshot(dbPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-cursor-'));
  const copy = path.join(tmp, path.basename(dbPath));
  fs.copyFileSync(dbPath, copy);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
  }
  return { db: new DatabaseSync(copy), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function globalSnapshotFingerprint(dbPath) {
  try {
    const st = fs.statSync(dbPath);
    const walMtime = fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').mtimeMs : 0;
    return `${st.mtimeMs}:${st.size}:${walMtime}`;
  } catch {
    return null;
  }
}

// Cursor stores all composer bubbles in one global DB that can grow to multiple GB.
// Copy it once per process (invalidate on mtime/size change) instead of per workspace.
function getGlobalSnapshot(userDir) {
  const globalDb = path.join(userDir, 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(globalDb)) return null;
  const fingerprint = globalSnapshotFingerprint(globalDb);
  if (!fingerprint) return null;
  const cache = globalThis.__chronicleCursorGlobal ||= { snap: null, fingerprint: null, userDir: null };
  if (cache.snap && cache.fingerprint === fingerprint && cache.userDir === userDir) return cache.snap;
  cache.snap?.cleanup();
  const snap = openSnapshot(globalDb);
  cache.snap = snap;
  cache.fingerprint = fingerprint;
  cache.userDir = userDir;
  return snap;
}

export function clearCursorGlobalCache() {
  globalThis.__chronicleCursorGlobal?.snap?.cleanup();
  globalThis.__chronicleCursorGlobal = null;
}

function itemTableGet(db, key) {
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

function diskKVGetMany(db, keys) {
  const out = new Map();
  if (!keys.length) return out;
  const chunkSize = 400;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    try {
      for (const row of db.prepare(`SELECT key, value FROM cursorDiskKV WHERE key IN (${placeholders})`).all(...chunk)) {
        try { out.set(row.key, JSON.parse(row.value)); } catch {}
      }
    } catch {}
  }
  return out;
}

function workspaceFolder(wsDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    const uri = meta.folder || meta.workspace;
    if (uri?.startsWith('file://')) return decodeURIComponent(uri.replace('file://', ''));
  } catch {}
  return null;
}

export function scanCursorProjects(userDir = cursorUserDir()) {
  const wsRoot = path.join(userDir, 'workspaceStorage');
  if (!fs.existsSync(wsRoot)) return [];
  const results = [];
  for (const d of fs.readdirSync(wsRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const wsDir = path.join(wsRoot, d.name);
    const dbPath = path.join(wsDir, 'state.vscdb');
    if (!fs.existsSync(dbPath)) continue;
    const folder = workspaceFolder(wsDir);
    let snap;
    try {
      snap = openSnapshot(dbPath);
      let sessionCount = 0, messageEstimate = 0;
      const chat = itemTableGet(snap.db, 'workbench.panel.aichat.view.aichat.chatdata');
      for (const tab of chat?.tabs || []) {
        sessionCount++; messageEstimate += (tab.bubbles || []).length;
      }
      const composers = itemTableGet(snap.db, 'composer.composerData');
      for (const c of composers?.allComposers || []) {
        sessionCount++;
        messageEstimate += c.fullConversationHeadersOnly?.length || c.conversation?.length || 10;
      }
      if (!sessionCount) continue;
      results.push({
        source: 'cursor', logDir: wsDir, name: folder ? path.basename(folder) : d.name,
        physicalPath: folder, sessionCount, messageEstimate,
      });
    } catch { /* unreadable workspace db — skip */ }
    finally { snap?.cleanup(); }
  }
  return results;
}

export function parseCursorWorkspace(wsDir, userDir = cursorUserDir()) {
  const dbPath = path.join(wsDir, 'state.vscdb');
  const folder = workspaceFolder(wsDir);
  const snap = openSnapshot(dbPath);
  try {
    const out = [];

    // Legacy chat tabs
    const chat = itemTableGet(snap.db, 'workbench.panel.aichat.view.aichat.chatdata');
    for (const tab of chat?.tabs || []) {
      const events = [];
      for (const b of tab.bubbles || []) {
        const ev = bubbleToEvent(b);
        if (ev) events.push(...ev);
      }
      out.push(makeSession(`cursor-chat-${tab.tabId}`, wsDir, folder, tab.chatTitle, events, tab.lastSendTime));
    }

    // Composer sessions: headers in workspace DB, bubbles in global cursorDiskKV
    const composers = itemTableGet(snap.db, 'composer.composerData');
    const composerList = composers?.allComposers || [];
    const needsGlobal = composerList.some((c) => !c.conversation);
    const globalSnap = needsGlobal ? getGlobalSnapshot(userDir) : null;
    const composerDataMap = globalSnap
      ? diskKVGetMany(globalSnap.db, composerList.filter((c) => !c.conversation).map((c) => `composerData:${c.composerId}`))
      : new Map();
    const bubbleKeys = [];
    for (const c of composerList) {
      if (c.conversation) continue;
      const data = composerDataMap.get(`composerData:${c.composerId}`);
      const headers = data?.fullConversationHeadersOnly || c.fullConversationHeadersOnly || [];
      for (const h of headers) bubbleKeys.push(`bubbleId:${c.composerId}:${h.bubbleId}`);
    }
    const bubbleMap = globalSnap ? diskKVGetMany(globalSnap.db, bubbleKeys) : new Map();

    for (const c of composerList) {
      const events = [];
      let conv = c.conversation;
      if (!conv && globalSnap) {
        const data = composerDataMap.get(`composerData:${c.composerId}`);
        conv = data?.conversation;
        if (!conv) {
          const headers = data?.fullConversationHeadersOnly || c.fullConversationHeadersOnly || [];
          if (headers.length) {
            conv = [];
            for (const h of headers) {
              const bubble = bubbleMap.get(`bubbleId:${c.composerId}:${h.bubbleId}`);
              if (bubble) conv.push(bubble);
            }
          }
        }
      }
      for (const b of conv || []) {
        const ev = bubbleToEvent(b);
        if (ev) events.push(...ev);
      }
      out.push(makeSession(`cursor-composer-${c.composerId}`, wsDir, folder,
        c.name || c.text?.slice(0, 100), events, c.createdAt));
    }
    return out.filter((s) => s.events.length);
  } finally {
    snap.cleanup();
  }
}

function makeSession(id, wsDir, folder, title, events, createdAt) {
  const timestamps = events.map((e) => e.ts).filter(Boolean).sort();
  const fallback = createdAt ? new Date(createdAt).toISOString() : null;
  return {
    session: {
      id, source: 'cursor', file_path: path.join(wsDir, 'state.vscdb'), cwd: folder,
      started_at: timestamps[0] ?? fallback,
      ended_at: timestamps[timestamps.length - 1] ?? fallback,
      first_prompt: (events.find((e) => e.kind === 'user')?.text || title || '').slice(0, 200),
      skipped: 0,
    },
    events,
  };
}

// Cursor bubble → normalized events. type 1/'user' = user, 2/'ai' = assistant.
function bubbleToEvent(b) {
  const ts = b.timingInfo?.clientStartTime || b.createdAt || null;
  const iso = ts ? new Date(ts).toISOString() : null;
  const events = [];
  const text = b.text || b.richText?.text || '';
  const isUser = b.type === 1 || b.type === 'user';
  if (text.trim()) events.push({ ts: iso, kind: isUser ? 'user' : 'assistant', text, model: b.modelType || null });
  if (b.thinking?.text) events.push({ ts: iso, kind: 'thinking', text: b.thinking.text });
  for (const t of b.toolResults || []) {
    events.push({ ts: iso, kind: 'tool_use', tool_name: t.toolName || t.name || 'tool', tool_input: JSON.stringify(t.args ?? {}), tool_use_id: t.toolCallId });
    if (t.result != null) events.push({ ts: iso, kind: 'tool_result', text: typeof t.result === 'string' ? t.result : JSON.stringify(t.result), tool_use_id: t.toolCallId });
  }
  return events.length ? events : null;
}
