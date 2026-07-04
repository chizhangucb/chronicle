import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const OPENCODE_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');

// Never touch OpenCode's live DB: copy db + WAL/SHM to a temp dir and read that.
function openSnapshot(dbPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-oc-'));
  const copy = path.join(tmp, 'opencode.db');
  fs.copyFileSync(dbPath, copy);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, copy + ext);
  }
  return { db: new DatabaseSync(copy), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

export function scanOpencodeProjects(dbPath = OPENCODE_DB) {
  if (!fs.existsSync(dbPath)) return [];
  let snap;
  try {
    snap = openSnapshot(dbPath);
    const rows = snap.db.prepare(`
      SELECT s.directory AS dir, COUNT(DISTINCT s.id) AS sessions, COUNT(m.id) AS messages
      FROM session s LEFT JOIN message m ON m.session_id = s.id
      WHERE s.parent_id IS NULL
      GROUP BY s.directory`).all();
    return rows.map((r) => ({
      source: 'opencode',
      logDir: dbPath,
      directory: r.dir,
      name: path.basename(r.dir),
      physicalPath: r.dir,
      sessionCount: r.sessions,
      messageEstimate: r.messages,
    }));
  } catch {
    return [];
  } finally {
    snap?.cleanup();
  }
}

// Parse all top-level sessions for one project directory.
export function parseOpencodeSessions(dbPath, directory) {
  const snap = openSnapshot(dbPath);
  try {
    const sessions = snap.db.prepare(
      'SELECT * FROM session WHERE directory = ? AND parent_id IS NULL').all(directory);
    return sessions.map((s) => {
      const parts = snap.db.prepare(`
        SELECT p.data AS part_data, p.time_created AS ts, m.data AS msg_data, m.id AS msg_id
        FROM part p JOIN message m ON m.id = p.message_id
        WHERE p.session_id = ?
        ORDER BY m.time_created, m.id, p.time_created, p.id`).all(s.id);
      const events = [];
      let firstPrompt = null;
      for (const row of parts) {
        let part, msg;
        try { part = JSON.parse(row.part_data); msg = JSON.parse(row.msg_data); } catch { continue; }
        const ts = new Date(row.ts).toISOString();
        const model = msg.modelID || msg.model?.modelID || null;
        if (part.type === 'text' && part.text?.trim()) {
          const kind = msg.role === 'user' ? 'user' : 'assistant';
          events.push({ ts, kind, text: part.text, model });
          if (kind === 'user' && !firstPrompt) firstPrompt = part.text.slice(0, 200);
        } else if (part.type === 'reasoning' && part.text?.trim()) {
          events.push({ ts, kind: 'thinking', text: part.text, model });
        } else if (part.type === 'tool') {
          events.push({
            ts, kind: 'tool_use', model,
            tool_name: part.tool, tool_use_id: part.callID,
            tool_input: JSON.stringify(part.state?.input ?? {}),
          });
          if (part.state?.output != null) {
            events.push({
              ts, kind: 'tool_result', tool_use_id: part.callID,
              text: typeof part.state.output === 'string' ? part.state.output : JSON.stringify(part.state.output),
            });
          }
        }
      }
      return {
        session: {
          id: `oc-${s.id}`,
          source: 'opencode',
          file_path: dbPath,
          cwd: s.directory,
          started_at: new Date(s.time_created).toISOString(),
          ended_at: new Date(s.time_updated).toISOString(),
          first_prompt: firstPrompt || s.title,
          skipped: 0,
        },
        events,
      };
    });
  } finally {
    snap.cleanup();
  }
}
