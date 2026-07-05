import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const GEMINI_TMP = path.join(os.homedir(), '.gemini', 'tmp');

// Gemini CLI stores per-project data under ~/.gemini/tmp/<project_hash>/:
//   logs.json          — [{sessionId, messageId, type, message, timestamp}]
//   chats/*.json       — saved chats {sessionId?, messages|history: [...]}
// The project hash doesn't reveal the physical path, so imported projects get a
// virtual "gemini-project:<hash>" path and surface as "Needs association" (FR-PM-3).

export function scanGeminiProjects(baseDir = GEMINI_TMP) {
  if (!fs.existsSync(baseDir)) return [];
  const results = [];
  for (const d of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(baseDir, d.name);
    const logs = path.join(dir, 'logs.json');
    const chatsDir = path.join(dir, 'chats');
    let sessionCount = 0, messageEstimate = 0;
    if (fs.existsSync(logs)) {
      try {
        const entries = JSON.parse(fs.readFileSync(logs, 'utf8'));
        const ids = new Set(entries.map((e) => e.sessionId).filter(Boolean));
        sessionCount += ids.size;
        messageEstimate += entries.length;
      } catch {}
    }
    if (fs.existsSync(chatsDir)) {
      const files = fs.readdirSync(chatsDir).filter((f) => f.endsWith('.json'));
      sessionCount += files.length;
      messageEstimate += files.length * 20;
    }
    if (!sessionCount) continue;
    results.push({
      source: 'gemini-cli', logDir: dir, name: `gemini-${d.name.slice(0, 8)}`,
      physicalPath: `gemini-project:${d.name}`, needsAssociation: true,
      sessionCount, messageEstimate,
    });
  }
  return results;
}

export function parseGeminiProject(dir) {
  const hash = path.basename(dir);
  const virtualPath = `gemini-project:${hash}`;
  const sessions = [];

  // logs.json → group by sessionId
  const logsFile = path.join(dir, 'logs.json');
  if (fs.existsSync(logsFile)) {
    let entries = [];
    try { entries = JSON.parse(fs.readFileSync(logsFile, 'utf8')); } catch {}
    const bySession = new Map();
    for (const e of entries) {
      if (!e.sessionId) continue;
      if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
      bySession.get(e.sessionId).push(e);
    }
    for (const [sid, items] of bySession) {
      const events = items
        .sort((a, b) => (a.messageId ?? 0) - (b.messageId ?? 0))
        .map((e) => ({
          ts: e.timestamp ?? null,
          kind: e.type === 'user' ? 'user' : 'assistant',
          text: typeof e.message === 'string' ? e.message : JSON.stringify(e.message),
        }))
        .filter((e) => e.text?.trim());
      if (!events.length) continue;
      sessions.push(makeSession(`gemini-${sid}`, logsFile, virtualPath, events));
    }
  }

  // chats/*.json → one session per file
  const chatsDir = path.join(dir, 'chats');
  if (fs.existsSync(chatsDir)) {
    for (const f of fs.readdirSync(chatsDir).filter((f) => f.endsWith('.json'))) {
      const file = path.join(chatsDir, f);
      let chat;
      try { chat = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      const msgs = chat.messages || chat.history || [];
      const events = [];
      for (const m of msgs) {
        const role = m.role || m.type;
        const text = typeof m.content === 'string' ? m.content
          : (m.parts || []).map((p) => p.text || '').join('') || m.text || '';
        if (!text.trim()) continue;
        events.push({ ts: m.timestamp ?? chat.lastUpdated ?? null, kind: role === 'user' ? 'user' : 'assistant', text });
      }
      if (events.length) {
        sessions.push(makeSession(`gemini-chat-${hash}-${path.basename(f, '.json')}`, file, virtualPath, events));
      }
    }
  }
  return sessions;
}

function makeSession(id, file, cwd, events) {
  const timestamps = events.map((e) => e.ts).filter(Boolean).sort();
  return {
    session: {
      id, source: 'gemini-cli', file_path: file, cwd,
      started_at: timestamps[0] ?? null,
      ended_at: timestamps[timestamps.length - 1] ?? null,
      first_prompt: events.find((e) => e.kind === 'user')?.text?.slice(0, 200) ?? null,
      skipped: 0,
    },
    events,
  };
}
