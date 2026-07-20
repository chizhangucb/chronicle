import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./fixtures/cursor-user', import.meta.url));
fs.rmSync(root, { recursive: true, force: true });
const wsDir = path.join(root, 'workspaceStorage', 'abc123');
const projectPath = '/Users/chizhang/health-analyst';
const agentId = 'agent-session-1';
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(path.join(root, 'globalStorage'), { recursive: true });

fs.writeFileSync(path.join(wsDir, 'workspace.json'),
  JSON.stringify({ folder: `file://${projectPath}` }));

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
g.exec(`CREATE TABLE composerHeaders (
  composerId TEXT PRIMARY KEY,
  workspaceId TEXT,
  createdAt INTEGER,
  lastUpdatedAt INTEGER,
  isArchived INTEGER,
  isSubagent INTEGER,
  recency INTEGER,
  checkpointAt INTEGER,
  value TEXT
)`);
g.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:comp1:b1',
  JSON.stringify({ type: 1, text: 'Refactor the dashboard to use the new chart API', timingInfo: { clientStartTime: t0 + 60000 } }));
g.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:comp1:b2',
  JSON.stringify({ type: 2, text: 'Done — replaced Recharts wrappers.', thinking: { text: 'Need to check chart imports first' },
    toolResults: [{ toolName: 'read_file', args: { path: 'src/app/dashboard/page.tsx' }, result: 'export default ...', toolCallId: 'tc1' }],
    timingInfo: { clientStartTime: t0 + 65000 } }));
g.prepare(`INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  agentId,
  'abc123',
  t0 + 120000,
  t0 + 125000,
  0,
  0,
  t0 + 125000,
  null,
  JSON.stringify({
    type: 'head',
    composerId: agentId,
    name: 'Agent mode export test',
    createdAt: t0 + 120000,
    lastUpdatedAt: t0 + 125000,
    workspaceIdentifier: {
      uri: { fsPath: projectPath, external: `file://${projectPath}` },
    },
  }),
);
g.close();

const transcriptDir = path.join(root, 'projects', 'Users-chizhang-health-analyst', 'agent-transcripts', agentId);
fs.mkdirSync(transcriptDir, { recursive: true });
fs.writeFileSync(path.join(transcriptDir, `${agentId}.jsonl`), [
  JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<timestamp>Wednesday, Jul 1, 2026, 8:05 AM (UTC)</timestamp>\n<user_query>\nAdd agent transcript import\n</user_query>' }] } }),
  JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Implemented agent transcript parsing.' }] } }),
].join('\n') + '\n');

// Point cursorProjectsDir override through fixture by mirroring under ~/.cursor/projects in fixture only for tests.
// Tests set CHRONICLE_CURSOR_DIR; agent transcript root still uses real ~/.cursor/projects unless we also relocate it.
// For fixture validation, copy transcript tree to a path the parser can reach via env override in the test runner.
const fixtureProjects = path.join(root, 'projects');
process.stdout.write(JSON.stringify({ root, projectPath, agentId, fixtureProjects }) + '\n');
console.log('fixture written to', root);
