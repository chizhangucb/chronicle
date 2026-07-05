import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./fixtures/cursor-user', import.meta.url));
fs.rmSync(root, { recursive: true, force: true });
const wsDir = path.join(root, 'workspaceStorage', 'abc123');
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(path.join(root, 'globalStorage'), { recursive: true });

fs.writeFileSync(path.join(wsDir, 'workspace.json'),
  JSON.stringify({ folder: 'file:///Users/chizhang/health-analyst' }));

const ws = new DatabaseSync(path.join(wsDir, 'state.vscdb'));
ws.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
const t0 = Date.parse('2026-07-01T08:00:00Z');
// legacy chat tab
ws.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
  'workbench.panel.aichat.view.aichat.chatdata',
  JSON.stringify({ tabs: [{ tabId: 'tab1', chatTitle: 'Fix auth bug', lastSendTime: t0, bubbles: [
    { type: 'user', text: 'Why does login fail with OAuth?', timingInfo: { clientStartTime: t0 } },
    { type: 'ai', text: 'The redirect URI is mismatched.', modelType: 'gpt-4', timingInfo: { clientStartTime: t0 + 5000 } },
  ]}]}));
// composer with headers → bubbles live in global KV
ws.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(
  'composer.composerData',
  JSON.stringify({ allComposers: [{ composerId: 'comp1', name: 'Refactor dashboard', createdAt: t0 + 60000,
    fullConversationHeadersOnly: [{ bubbleId: 'b1' }, { bubbleId: 'b2' }] }] }));
ws.close();

const g = new DatabaseSync(path.join(root, 'globalStorage', 'state.vscdb'));
g.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
g.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:comp1:b1',
  JSON.stringify({ type: 1, text: 'Refactor the dashboard to use the new chart API', timingInfo: { clientStartTime: t0 + 60000 } }));
g.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:comp1:b2',
  JSON.stringify({ type: 2, text: 'Done — replaced Recharts wrappers.', thinking: { text: 'Need to check chart imports first' },
    toolResults: [{ toolName: 'read_file', args: { path: 'src/app/dashboard/page.tsx' }, result: 'export default ...', toolCallId: 'tc1' }],
    timingInfo: { clientStartTime: t0 + 65000 } }));
g.close();
console.log('fixture written to', root);
