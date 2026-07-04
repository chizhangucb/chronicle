import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// GitHub Copilot Chat (VS Code): sessions live under the editor's
// workspaceStorage/<hash>/chatSessions/*.json; workspace.json → real folder.
export function vscodeUserDirs() {
  if (process.env.CHRONICLE_VSCODE_DIR) return [process.env.CHRONICLE_VSCODE_DIR];
  const home = os.homedir();
  const roots = process.platform === 'darwin'
    ? [path.join(home, 'Library', 'Application Support')]
    : process.platform === 'win32'
      ? [process.env.APPDATA || path.join(home, 'AppData', 'Roaming')]
      : [path.join(home, '.config')];
  // distribution disambiguation: stable / insiders / VSCodium
  const dists = ['Code', 'Code - Insiders', 'VSCodium'];
  return roots.flatMap((r) => dists.map((d) => path.join(r, d, 'User'))).filter(fs.existsSync);
}

function workspaceFolder(wsDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    const uri = meta.folder || meta.workspace;
    if (uri?.startsWith('file://')) return decodeURIComponent(uri.replace('file://', ''));
  } catch {}
  return null;
}

export function scanCopilotProjects(userDirs = vscodeUserDirs()) {
  const results = [];
  for (const userDir of userDirs) {
    const wsRoot = path.join(userDir, 'workspaceStorage');
    if (!fs.existsSync(wsRoot)) continue;
    for (const d of fs.readdirSync(wsRoot, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const wsDir = path.join(wsRoot, d.name);
      const chatDir = path.join(wsDir, 'chatSessions');
      if (!fs.existsSync(chatDir)) continue;
      const files = fs.readdirSync(chatDir).filter((f) => f.endsWith('.json'));
      if (!files.length) continue;
      const folder = workspaceFolder(wsDir);
      results.push({
        source: 'copilot-chat', logDir: wsDir,
        name: folder ? path.basename(folder) : d.name,
        physicalPath: folder, sessionCount: files.length,
        messageEstimate: files.length * 15,
      });
    }
  }
  return results;
}

export function parseCopilotWorkspace(wsDir) {
  const chatDir = path.join(wsDir, 'chatSessions');
  const folder = workspaceFolder(wsDir);
  const sessions = [];
  for (const f of fs.readdirSync(chatDir).filter((f) => f.endsWith('.json'))) {
    let chat;
    try { chat = JSON.parse(fs.readFileSync(path.join(chatDir, f), 'utf8')); } catch { continue; }
    const events = [];
    for (const req of chat.requests ?? []) {
      const ts = req.timestamp ? new Date(req.timestamp).toISOString() : (chat.creationDate ? new Date(chat.creationDate).toISOString() : null);
      const userText = req.message?.text ?? (req.message?.parts ?? []).map((p) => p.text ?? '').join('');
      if (userText?.trim()) events.push({ ts, kind: 'user', text: userText });
      const responseText = (Array.isArray(req.response) ? req.response : [])
        .map((r) => typeof r === 'string' ? r : r.value ?? '').filter(Boolean).join('');
      if (responseText.trim()) events.push({ ts, kind: 'assistant', text: responseText, model: req.agent?.id ?? 'copilot' });
      // tool/reference usage surfaces as contentReferences
      for (const ref of req.contentReferences ?? []) {
        const p = ref.reference?.uri?.path || ref.reference?.path;
        if (p) events.push({ ts, kind: 'tool_use', tool_name: 'reference', tool_input: JSON.stringify({ file_path: p }) });
      }
    }
    if (!events.length) continue;
    const timestamps = events.map((e) => e.ts).filter(Boolean).sort();
    sessions.push({
      session: {
        id: `copilot-${path.basename(f, '.json')}`,
        source: 'copilot-chat',
        file_path: path.join(chatDir, f),
        cwd: folder,
        started_at: timestamps[0] ?? null,
        ended_at: timestamps[timestamps.length - 1] ?? null,
        first_prompt: events.find((e) => e.kind === 'user')?.text?.slice(0, 200) ?? null,
        skipped: 0,
      },
      events,
    });
  }
  return sessions;
}
