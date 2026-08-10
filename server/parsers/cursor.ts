import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Event, ParseResult, ScannedProject } from '../../shared/types.ts';

interface Snapshot {
  db: DatabaseSync;
  cleanup: () => void;
}

interface CursorGlobalCache {
  snap: Snapshot | null;
  fingerprint: string | null;
  userDir: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __chronicleCursorGlobal: CursorGlobalCache | null | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor's own storage shapes (SQLite ItemTable/cursorDiskKV JSON blobs,
// agent-transcript JSONL rows) — external format, loosely typed on purpose.

interface AgentComposerHeader {
  composerId: string;
  name: string;
  createdAt: number;
  lastUpdatedAt: number;
  isArchived: boolean;
}

interface ComposerHeaderRow {
  composerId: string;
  createdAt: number;
  lastUpdatedAt: number;
  isArchived: number;
  isSubagent: number;
  value: string;
}

interface CursorToolResult {
  toolName?: string;
  name?: string;
  args?: unknown;
  toolCallId?: string;
  result?: unknown;
}

interface CursorBubble {
  type?: number | string;
  text?: string;
  richText?: { text?: string };
  thinking?: { text?: string };
  toolResults?: CursorToolResult[];
  timingInfo?: { clientStartTime?: number | string };
  createdAt?: number | string;
  modelType?: string;
}

interface ChatTab {
  tabId: string;
  chatTitle?: string;
  lastSendTime?: number;
  bubbles?: CursorBubble[];
}

interface ChatData {
  tabs?: ChatTab[];
}

interface ComposerConvHeader {
  bubbleId: string;
}

interface ComposerEntry {
  composerId: string;
  name?: string;
  text?: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  conversation?: CursorBubble[];
  fullConversationHeadersOnly?: ComposerConvHeader[];
}

interface ComposersData {
  allComposers?: ComposerEntry[];
}

interface TranscriptPart {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface TranscriptRow {
  type?: string;
  role?: string;
  message?: { content?: TranscriptPart[] };
}

interface AgentSessionOptions {
  createdAt?: number;
  lastUpdatedAt?: number;
}

export function cursorUserDir(): string {
  if (process.env.CHRONICLE_CURSOR_DIR) return process.env.CHRONICLE_CURSOR_DIR;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  return path.join(home, '.config', 'Cursor', 'User');
}

export function cursorProjectsDir(): string {
  if (process.env.CHRONICLE_CURSOR_PROJECTS_DIR) return process.env.CHRONICLE_CURSOR_PROJECTS_DIR;
  return path.join(os.homedir(), '.cursor', 'projects');
}

// Cursor slug: strip leading slash, then map both path separators and underscores to dashes.
export function cursorProjectSlug(fsPath: string): string {
  return fsPath.replace(/^\//, '').replace(/[_/]/g, '-');
}

function agentTranscriptRoot(fsPath: string): string {
  return path.join(cursorProjectsDir(), cursorProjectSlug(fsPath), 'agent-transcripts');
}

// Read-only guarantee: copy the SQLite file (+WAL) to temp before opening.
function openSnapshot(dbPath: string): Snapshot {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-cursor-'));
  const copy = path.join(tmp, path.basename(dbPath));
  fs.copyFileSync(dbPath, copy);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
  }
  return { db: new DatabaseSync(copy), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

function globalSnapshotFingerprint(dbPath: string): string | null {
  try {
    const st = fs.statSync(dbPath);
    const walMtime = fs.existsSync(dbPath + '-wal') ? fs.statSync(dbPath + '-wal').mtimeMs : 0;
    return `${st.mtimeMs}:${st.size}:${walMtime}`;
  } catch {
    return null;
  }
}

function getGlobalSnapshot(userDir: string): Snapshot | null {
  const globalDb = path.join(userDir, 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(globalDb)) return null;
  const fingerprint = globalSnapshotFingerprint(globalDb);
  if (!fingerprint) return null;
  const cache = globalThis.__chronicleCursorGlobal ??= { snap: null, fingerprint: null, userDir: null };
  if (cache.snap && cache.fingerprint === fingerprint && cache.userDir === userDir) return cache.snap;
  cache.snap?.cleanup();
  const snap = openSnapshot(globalDb);
  cache.snap = snap;
  cache.fingerprint = fingerprint;
  cache.userDir = userDir;
  return snap;
}

export function clearCursorGlobalCache(): void {
  globalThis.__chronicleCursorGlobal?.snap?.cleanup();
  globalThis.__chronicleCursorGlobal = null;
}

function itemTableGet<T = unknown>(db: DatabaseSync, key: string): T | null {
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

function diskKVGet<T = unknown>(db: DatabaseSync, key: string): T | null {
  try {
    const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}

function workspaceFolder(wsDir: string): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    const uri = meta.folder || meta.workspace;
    if (uri?.startsWith('file://')) return decodeURIComponent(uri.replace('file://', ''));
  } catch {}
  return null;
}

function headerProjectPath(value: unknown): string | null {
  try {
    const v = typeof value === 'string' ? JSON.parse(value) : value;
    return v.workspaceIdentifier?.uri?.fsPath
      || v.agentLocation?.environment?.uri?.fsPath
      || v.draftTarget?.environment?.uri?.fsPath
      || null;
  } catch { return null; }
}

function listAgentComposerHeaders(globalDb: DatabaseSync, folder: string): AgentComposerHeader[] {
  if (!globalDb || !folder) return [];
  try {
    const rows = globalDb.prepare('SELECT composerId, createdAt, lastUpdatedAt, isArchived, isSubagent, value FROM composerHeaders').all() as unknown as ComposerHeaderRow[];
    const out: AgentComposerHeader[] = [];
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

function countAgentSessions(folder: string, userDir: string = cursorUserDir()): { sessions: number; messages: number } {
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

function isPlausibleIso(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const y = new Date(iso).getFullYear();
  return y >= 2020 && y < 2100;
}

// Cursor bubbles often store clientStartTime as ms offset from session start, not epoch ms.
function normalizeCursorMs(raw: number | string | null | undefined, anchorMs: number | string | null): string | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n >= 946684800000) return new Date(n).toISOString(); // absolute epoch ms (>= 2000-01-01)
  const anchor = Number(anchorMs);
  if (Number.isFinite(anchor) && anchor >= 946684800000) return new Date(anchor + n).toISOString();
  return null;
}

function anchorIso(createdAt: number | undefined, lastUpdatedAt: number | undefined): { start: string | null; end: string | null } {
  const start = normalizeCursorMs(createdAt, null);
  const end = normalizeCursorMs(lastUpdatedAt, null);
  return { start: isPlausibleIso(start) ? start : null, end: isPlausibleIso(end) ? end : null };
}

function fileMtimeIso(filePath: string): string | null {
  try {
    const iso = new Date(fs.statSync(filePath).mtimeMs).toISOString();
    return isPlausibleIso(iso) ? iso : null;
  } catch { return null; }
}
function extractTimestamp(text: string): string | null {
  const m = text.match(/<timestamp>([^<]+)<\/timestamp>/);
  if (!m) return null;
  const d = new Date(m[1]);
  const iso = Number.isNaN(d.getTime()) ? null : d.toISOString();
  return isPlausibleIso(iso) ? iso : null;
}

function stripUserEnvelope(text: string): string {
  return text
    .replace(/<timestamp>[^<]*<\/timestamp>\s*/g, '')
    .replace(/<user_query>\s*/g, '')
    .replace(/<\/user_query>\s*/g, '')
    .trim();
}

export function parseAgentTranscriptJsonl(filePath: string, { createdAt, lastUpdatedAt }: AgentSessionOptions = {}): Event[] {
  const { start: anchorStart, end: anchorEnd } = anchorIso(createdAt, lastUpdatedAt);
  const fileEnd = fileMtimeIso(filePath);
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const events: Event[] = [];
  let turnTs: string | null = anchorStart;
  for (const line of lines) {
    let row: TranscriptRow;
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
    const last = events.at(-1) as Event;
    if (end && !isPlausibleIso(last.ts)) last.ts = end;
  }
  return events;
}

function parseComposerFromGlobal(globalDb: DatabaseSync, header: AgentComposerHeader): Event[] {
  const events: Event[] = [];
  const data = diskKVGet<{ conversation?: CursorBubble[]; fullConversationHeadersOnly?: ComposerConvHeader[] }>(globalDb, `composerData:${header.composerId}`);
  let conv = data?.conversation;
  if (!conv && (data?.fullConversationHeadersOnly)) {
    conv = [];
    for (const h of data.fullConversationHeadersOnly) {
      const bubble = diskKVGet<CursorBubble>(globalDb, `bubbleId:${header.composerId}:${h.bubbleId}`);
      if (bubble) conv.push(bubble);
    }
  }
  for (const b of conv || []) {
    const ev = bubbleToEvent(b, header.createdAt);
    if (ev) events.push(...ev);
  }
  return events;
}

export function parseCursorAgentSessions(folder: string | null, userDir: string = cursorUserDir()): ParseResult[] {
  if (!folder) return [];
  const globalSnap = getGlobalSnapshot(userDir);
  try {
    const headers = globalSnap ? listAgentComposerHeaders(globalSnap.db, folder) : [];
    const out: ParseResult[] = [];
    for (const h of headers) {
      const transcriptFile = path.join(agentTranscriptRoot(folder), h.composerId, `${h.composerId}.jsonl`);
      let events: Event[] = [];
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

function mergeSessions(...groups: ParseResult[][]): ParseResult[] {
  const byId = new Map<string, ParseResult>();
  for (const group of groups) {
    for (const item of group) byId.set(item.session.id, item);
  }
  return [...byId.values()];
}

export function scanCursorProjects(userDir: string = cursorUserDir()): ScannedProject[] {
  const wsRoot = path.join(userDir, 'workspaceStorage');
  const results: ScannedProject[] = [];
  const seenPaths = new Set<string>();
  const agentCounted = new Set<string>();

  if (fs.existsSync(wsRoot)) {
    for (const d of fs.readdirSync(wsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const wsDir = path.join(wsRoot, d.name);
      const dbPath = path.join(wsDir, 'state.vscdb');
      if (!fs.existsSync(dbPath)) continue;
      const folder = workspaceFolder(wsDir);
      let snap: Snapshot | undefined;
      try {
        snap = openSnapshot(dbPath);
        let sessionCount = 0;
        let messageEstimate = 0;
        const chat = itemTableGet<ChatData>(snap.db, 'workbench.panel.aichat.view.aichat.chatdata');
        for (const tab of chat?.tabs || []) {
          sessionCount++;
          messageEstimate += (tab.bubbles || []).length;
        }
        const composers = itemTableGet<ComposersData>(snap.db, 'composer.composerData');
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
        const rows = globalSnap.db.prepare('SELECT value FROM composerHeaders').all() as unknown as { value: string }[];
        const agentOnly = new Set<string>();
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

export function parseCursorWorkspace(wsDir: string, userDir: string = cursorUserDir(), physicalPath: string | null = null): ParseResult[] {
  if (wsDir.endsWith(`${path.sep}agent-transcripts`) || wsDir.endsWith('/agent-transcripts')) {
    const folder = physicalPath || null;
    return parseCursorAgentSessions(folder, userDir).filter((s) => s.events.length);
  }

  const dbPath = path.join(wsDir, 'state.vscdb');
  const folder = physicalPath || workspaceFolder(wsDir);
  const snap = openSnapshot(dbPath);
  const globalSnap = getGlobalSnapshot(userDir);
  try {
    const out: ParseResult[] = [];

    // Legacy chat tabs
    const chat = itemTableGet<ChatData>(snap.db, 'workbench.panel.aichat.view.aichat.chatdata');
    for (const tab of chat?.tabs || []) {
      const events: Event[] = [];
      for (const b of tab.bubbles || []) {
        const ev = bubbleToEvent(b, tab.lastSendTime);
        if (ev) events.push(...ev);
      }
      out.push(makeSession(`cursor-chat-${tab.tabId}`, wsDir, folder, tab.chatTitle, events, tab.lastSendTime, null, tab.lastSendTime));
    }

    // Legacy composer sessions: headers in workspace DB, bubbles in global cursorDiskKV
    const composers = itemTableGet<ComposersData>(snap.db, 'composer.composerData');
    for (const c of composers?.allComposers || []) {
      const events: Event[] = [];
      let conv = c.conversation;
      if (!conv && globalSnap) {
        const data = diskKVGet<{ conversation?: CursorBubble[]; fullConversationHeadersOnly?: ComposerConvHeader[] }>(globalSnap.db, `composerData:${c.composerId}`);
        conv = data?.conversation;
        if (!conv && (data?.fullConversationHeadersOnly || c.fullConversationHeadersOnly)) {
          conv = [];
          for (const h of data?.fullConversationHeadersOnly || c.fullConversationHeadersOnly || []) {
            const bubble = diskKVGet<CursorBubble>(globalSnap.db, `bubbleId:${c.composerId}:${h.bubbleId}`);
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

function makeSession(
  id: string,
  wsDir: string | null,
  folder: string | null,
  title: string | null | undefined,
  events: Event[],
  createdAt: number | undefined,
  filePath: string | null = null,
  lastUpdatedAt: number | undefined = undefined,
): ParseResult {
  const { start: anchorStart, end: anchorEnd } = anchorIso(createdAt, lastUpdatedAt);
  const fileEnd = filePath?.endsWith('.jsonl') ? fileMtimeIso(filePath) : null;
  const timestamps = events.map((e) => e.ts).filter(isPlausibleIso).sort() as string[];
  const started_at = timestamps[0] ?? anchorStart ?? fileEnd;
  const ended_at = timestamps[timestamps.length - 1] ?? anchorEnd ?? fileEnd ?? started_at;
  return {
    session: {
      id, source: 'cursor',
      file_path: filePath || (wsDir ? path.join(wsDir, 'state.vscdb') : null) as unknown as string,
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
function bubbleToEvent(b: CursorBubble, anchorMs: number | string | null | undefined): Event[] | null {
  const iso = normalizeCursorMs(b.timingInfo?.clientStartTime ?? b.createdAt ?? null, anchorMs ?? null);
  const events: Event[] = [];
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
