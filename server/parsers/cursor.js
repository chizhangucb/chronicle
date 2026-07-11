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

export function cursorProjectsDir() {
  if (process.env.CHRONICLE_CURSOR_PROJECTS_DIR) return process.env.CHRONICLE_CURSOR_PROJECTS_DIR;
  return path.join(os.homedir(), '.cursor', 'projects');
}

// Cursor names project dirs by stripping the leading slash and joining path segments with dashes.
export function cursorProjectSlug(fsPath) {
  return fsPath.replace(/^\//, '').replace(/\//g, '-');
}

function agentTranscriptRoot(fsPath) {
  return path.join(cursorProjectsDir(), cursorProjectSlug(fsPath), 'agent-transcripts');
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

function diskKVGet(db, key) {
  try {
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

function workspaceFolder(wsDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    const uri = meta.folder || meta.workspace;
    if (uri?.startsWith('file://')) return decodeURIComponent(uri.replace('file://', ''));
  } catch {}
  return null;
}

function headerProjectPath(value) {
  try {
    const v = typeof value === 'string' ? JSON.parse(value) : value;
    return v.workspaceIdentifier?.uri?.fsPath
      || v.agentLocation?.environment?.uri?.fsPath
      || v.draftTarget?.environment?.uri?.fsPath
      || null;
  } catch { return null; }
}

function listAgentComposerHeaders(globalDb, folder) {
  if (!globalDb || !folder) return [];
  try {
    const rows = globalDb.prepare('SELECT composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders').all();
    const out = [];
    for (const row of rows) {
      if (row.isSubagent) continue;
      const projectPath = headerProjectPath(row.value);
      if (projectPath !== folder) continue;
      let name = '';
      try { name = JSON.parse(row.value || '{}').name || ''; } catch {}
      out.push({
        composerId: row.composerId,
        name,
        createdAt: row.createdAt,
        lastUpdatedAt: row.lastUpdatedAt,
        isArchived: !!row.isArchived,
      });
    }
    return out;
  } catch { return []; }
}

function countAgentSessions(folder, userDir = cursorUserDir()) {
  const globalSnap = getGlobalSnapshot(userDir);
  if (!globalSnap) return { sessions: 0, messages: 0 };
  try {
    const headers = listAgentComposerHeaders(globalSnap.db, folder);
    let messages = 0;
    for (const h of headers) {
      const transcript = path.join(agentTranscriptRoot(folder), h.composerId, `${h.composerId}.jsonl`);
      if (fs.existsSync(transcript)) {
        messages += fs.readFileSync(transcript, 'utf8').trim().split('\n').filter(Boolean).length;
      }
    }
    return { sessions: headers.length, messages };
  } catch {
    return { sessions: 0, messages: 0 };
  }
}

function isPlausibleIso(iso) {
  if (!iso) return false;
  const y = new Date(iso).getFullYear();
  return y >= 2020 && y < 2100;
}

// Cursor bubbles often store clientStartTime as ms offset from session start, not epoch ms.
function normalizeCursorMs(raw, anchorMs) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n >= 946684800000) return new Date(n).toISOString(); // absolute epoch ms (>= 2000-01-01)
  const anchor = Number(anchorMs);
  if (Number.isFinite(anchor) && anchor >= 946684800000) return new Date(anchor + n).toISOString();
  return null;
}

function anchorIso(createdAt, lastUpdatedAt) {
  const start = normalizeCursorMs(createdAt, null);
  const end = normalizeCursorMs(lastUpdatedAt, null);
  return { start: isPlausibleIso(start) ? start : null, end: isPlausibleIso(end) ? end : null };
}

function fileMtimeIso(filePath) {
  try {
    const iso = new Date(fs.statSync(filePath).mtimeMs).toISOString();
    return isPlausibleIso(iso) ? iso : null;
  } catch { return null; }
}
function extractTimestamp(text) {
  const m = text.match(/<timestamp>([^<]+)<\/timestamp>/);
  if (!m) return null;
  const d = new Date(m[1]);
  const iso = Number.isNaN(d.getTime()) ? null : d.toISOString();
  return isPlausibleIso(iso) ? iso : null;
}

function stripUserEnvelope(text) {
  return text
    .replace(/<timestamp>[^<]*<\/timestamp>\s*/g, '')
    .replace(/<user_query>\s*/g, '')
    .replace(/<\/user_query>\s*/g, '')
    .trim();
}

export function parseAgentTranscriptJsonl(filePath, { createdAt, lastUpdatedAt } = {}) {
  const { start: anchorStart, end: anchorEnd } = anchorIso(createdAt, lastUpdatedAt);
  const fileEnd = fileMtimeIso(filePath);
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const events = [];
  let turnTs = anchorStart;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type === 'turn_ended') continue;
    const parts = row.message?.content || [];
    if (row.role === 'user') {
      for (const p of parts) {
        if (p.type !== 'text' || !p.text?.trim()) continue;
        const tagged = extractTimestamp(p.text);
        const ts = tagged || turnTs || anchorStart;
        if (tagged) turnTs = tagged;
        events.push({ ts, kind: 'user', text: stripUserEnvelope(p.text) });
      }
    } else if (row.role === 'assistant') {
      for (const p of parts) {
        const ts = turnTs || anchorStart;
        if (p.type === 'text' && p.text?.trim()) {
          events.push({ ts, kind: 'assistant', text: p.text });
        } else if (p.type === 'tool_use') {
          const toolUseId = `${p.name || 'tool'}-${events.length}`;
          events.push({
            ts,
            kind: 'tool_use',
            tool_name: p.name || 'tool',
            tool_input: JSON.stringify(p.input ?? {}),
            tool_use_id: toolUseId,
          });
        }
      }
    }
  }
  if (events.length && !events.some((e) => isPlausibleIso(e.ts))) {
    const fallback = anchorStart || fileEnd;
    if (fallback) events[0].ts = fallback;
  }
  if (events.length) {
    const end = [anchorEnd, fileEnd].filter(isPlausibleIso).sort().at(-1);
    if (end && !isPlausibleIso(events.at(-1).ts)) events.at(-1).ts = end;
  }
  return events;
}

function parseComposerFromGlobal(globalDb, header) {
  const events = [];
  const data = diskKVGet(globalDb, `composerData:${header.composerId}`);
  let conv = data?.conversation;
  if (!conv && (data?.fullConversationHeadersOnly)) {
    conv = [];
    for (const h of data.fullConversationHeadersOnly) {
      const bubble = diskKVGet(globalDb, `bubbleId:${header.composerId}:${h.bubbleId}`);
      if (bubble) conv.push(bubble);
    }
  }
  for (const b of conv || []) {
    const ev = bubbleToEvent(b, header.createdAt);
    if (ev) events.push(...ev);
  }
  return events;
}

export function parseCursorAgentSessions(folder, userDir = cursorUserDir()) {
  if (!folder) return [];
  const globalSnap = getGlobalSnapshot(userDir);
  try {
    const headers = globalSnap ? listAgentComposerHeaders(globalSnap.db, folder) : [];
    const out = [];
    for (const h of headers) {
      const transcriptFile = path.join(agentTranscriptRoot(folder), h.composerId, `${h.composerId}.jsonl`);
      let events = [];
      if (fs.existsSync(transcriptFile)) events = parseAgentTranscriptJsonl(transcriptFile, { createdAt: h.createdAt, lastUpdatedAt: h.lastUpdatedAt });
      else if (globalSnap) events = parseComposerFromGlobal(globalSnap.db, h);
      if (!events.length) continue;
      out.push(makeSession(
        `cursor-composer-${h.composerId}`,
        null,
        folder,
        h.name || events.find((e) => e.kind === 'user')?.text?.slice(0, 100) || '',
        events,
        h.createdAt,
        fs.existsSync(transcriptFile) ? transcriptFile : path.join(userDir, 'globalStorage', 'state.vscdb'),
        h.lastUpdatedAt,
      ));
    }
    return out;
  } catch {
    return [];
  }
}

function mergeSessions(...groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const item of group) byId.set(item.session.id, item);
  }
  return [...byId.values()];
}

export function scanCursorProjects(userDir = cursorUserDir()) {
  const wsRoot = path.join(userDir, 'workspaceStorage');
  const results = [];
  const seenPaths = new Set();
  const agentCounted = new Set();

  if (fs.existsSync(wsRoot)) {
    for (const d of fs.readdirSync(wsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const wsDir = path.join(wsRoot, d.name);
      const dbPath = path.join(wsDir, 'state.vscdb');
      if (!fs.existsSync(dbPath)) continue;
      const folder = workspaceFolder(wsDir);
      let snap;
      try {
        snap = openSnapshot(dbPath);
        let sessionCount = 0;
        let messageEstimate = 0;
        const chat = itemTableGet(snap.db, 'workbench.panel.aichat.view.aichat.chatdata');
        for (const tab of chat?.tabs || []) {
          sessionCount++;
          messageEstimate += (tab.bubbles || []).length;
        }
        const composers = itemTableGet(snap.db, 'composer.composerData');
        for (const c of composers?.allComposers || []) {
          sessionCount++;
          messageEstimate += c.fullConversationHeadersOnly?.length || c.conversation?.length || 10;
        }
        if (folder && !agentCounted.has(folder)) {
          agentCounted.add(folder);
          const agent = countAgentSessions(folder, userDir);
          sessionCount += agent.sessions;
          messageEstimate += agent.messages;
        }
        if (!sessionCount) continue;
        if (folder) seenPaths.add(folder);
        results.push({
          source: 'cursor', logDir: wsDir, name: folder ? path.basename(folder) : d.name,
          physicalPath: folder, sessionCount, messageEstimate,
        });
      } catch { /* unreadable workspace db — skip */ }
      finally { snap?.cleanup(); }
    }
  }

  // Projects with Agent transcripts but no legacy workspaceStorage sessions.
  const globalDb = path.join(userDir, 'globalStorage', 'state.vscdb');
  if (fs.existsSync(globalDb)) {
    const globalSnap = getGlobalSnapshot(userDir);
    if (globalSnap) {
      try {
        const rows = globalSnap.db.prepare('SELECT value FROM composerHeaders').all();
        const agentOnly = new Set();
        for (const row of rows) {
          const projectPath = headerProjectPath(row.value);
          if (!projectPath || seenPaths.has(projectPath)) continue;
          agentOnly.add(projectPath);
        }
        for (const physicalPath of agentOnly) {
          const agent = countAgentSessions(physicalPath, userDir);
          if (!agent.sessions) continue;
          results.push({
            source: 'cursor',
            logDir: agentTranscriptRoot(physicalPath),
            name: path.basename(physicalPath),
            physicalPath,
            sessionCount: agent.sessions,
            messageEstimate: agent.messages,
          });
          seenPaths.add(physicalPath);
        }
      } catch { /* unreadable global db */ }
    }
  }

  return results;
}

export function parseCursorWorkspace(wsDir, userDir = cursorUserDir(), physicalPath = null) {
  if (wsDir.endsWith(`${path.sep}agent-transcripts`) || wsDir.endsWith('/agent-transcripts')) {
    const folder = physicalPath || null;
    return parseCursorAgentSessions(folder, userDir).filter((s) => s.events.length);
  }

  const dbPath = path.join(wsDir, 'state.vscdb');
  const folder = physicalPath || workspaceFolder(wsDir);
  const snap = openSnapshot(dbPath);
  const globalSnap = getGlobalSnapshot(userDir);
  try {
    const out = [];

    // Legacy chat tabs
    const chat = itemTableGet(snap.db, 'workbench.panel.aichat.view.aichat.chatdata');
    for (const tab of chat?.tabs || []) {
      const events = [];
      for (const b of tab.bubbles || []) {
        const ev = bubbleToEvent(b, tab.lastSendTime);
        if (ev) events.push(...ev);
      }
      out.push(makeSession(`cursor-chat-${tab.tabId}`, wsDir, folder, tab.chatTitle, events, tab.lastSendTime, null, tab.lastSendTime));
    }

    // Legacy composer sessions: headers in workspace DB, bubbles in global cursorDiskKV
    const composers = itemTableGet(snap.db, 'composer.composerData');
    for (const c of composers?.allComposers || []) {
      const events = [];
      let conv = c.conversation;
      if (!conv && globalSnap) {
        const data = diskKVGet(globalSnap.db, `composerData:${c.composerId}`);
        conv = data?.conversation;
        if (!conv && (data?.fullConversationHeadersOnly || c.fullConversationHeadersOnly)) {
          conv = [];
          for (const h of data?.fullConversationHeadersOnly || c.fullConversationHeadersOnly || []) {
            const bubble = diskKVGet(globalSnap.db, `bubbleId:${c.composerId}:${h.bubbleId}`);
            if (bubble) conv.push(bubble);
          }
        }
      }
      for (const b of conv || []) {
        const ev = bubbleToEvent(b, c.createdAt);
        if (ev) events.push(...ev);
      }
      out.push(makeSession(`cursor-composer-${c.composerId}`, wsDir, folder,
        c.name || c.text?.slice(0, 100), events, c.createdAt, null, c.lastUpdatedAt || c.createdAt));
    }

    return mergeSessions(out, parseCursorAgentSessions(folder, userDir)).filter((s) => s.events.length);
  } finally {
    snap.cleanup();
  }
}

function makeSession(id, wsDir, folder, title, events, createdAt, filePath = null, lastUpdatedAt = null) {
  const { start: anchorStart, end: anchorEnd } = anchorIso(createdAt, lastUpdatedAt);
  const fileEnd = filePath?.endsWith('.jsonl') ? fileMtimeIso(filePath) : null;
  const timestamps = events.map((e) => e.ts).filter(isPlausibleIso).sort();
  const started_at = timestamps[0] ?? anchorStart ?? fileEnd;
  const ended_at = timestamps[timestamps.length - 1] ?? anchorEnd ?? fileEnd ?? started_at;
  return {
    session: {
      id, source: 'cursor',
      file_path: filePath || (wsDir ? path.join(wsDir, 'state.vscdb') : null),
      cwd: folder,
      started_at,
      ended_at,
      first_prompt: (events.find((e) => e.kind === 'user')?.text || title || '').slice(0, 200),
      skipped: 0,
    },
    events,
  };
}

// Cursor bubble → normalized events. type 1/'user' = user, 2/'ai' = assistant.
function bubbleToEvent(b, anchorMs) {
  const iso = normalizeCursorMs(b.timingInfo?.clientStartTime ?? b.createdAt ?? null, anchorMs);
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
