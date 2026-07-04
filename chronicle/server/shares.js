import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import { scanSession } from './security.js';

// Safe sharing (FR-SEC-8): tokenized links served by the local app.
// Redaction is baked in AT CREATION (one-way): the share stores only the
// redacted copy, so later rule edits or DB access can't leak the original.

db.exec(`
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,       -- redacted messages JSON, frozen at creation
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  views INTEGER DEFAULT 0
);`);

export function createShare(sessionId, days = 7) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error('Session not found');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id);
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId);
  const scan = scanSession(messages);
  const redactedBySeq = new Map(scan.messages.map((m) => [m.seq, m]));
  const frozen = messages.map((m) => {
    const r = redactedBySeq.get(m.seq);
    return {
      seq: m.seq, ts: m.ts, kind: m.kind, tool_name: m.tool_name,
      text: r ? r.redactedText : m.text,
      tool_input: r ? r.redactedInput : m.tool_input,
    };
  });
  const token = crypto.randomBytes(16).toString('hex');
  const expires = new Date(Date.now() + days * 86400000).toISOString();
  db.prepare('INSERT INTO shares (token, session_id, title, content, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, sessionId, `${project.name} — ${session.first_prompt?.slice(0, 80) ?? 'session'}`,
         JSON.stringify(frozen), expires);
  return { token, url: `/share/${token}`, expires_at: expires, redactions: scan.findingCount };
}

export function listShares() {
  return db.prepare(`SELECT id, token, session_id, title, created_at, expires_at, views,
    (expires_at < datetime('now')) AS expired FROM shares ORDER BY id DESC`).all();
}

export function revokeShare(id) {
  db.prepare('DELETE FROM shares WHERE id = ?').run(id);
}

// ---- Public share page ----

export const sharePage = express();

const KIND_LABEL = { user: 'You', assistant: 'AI', thinking: 'Thinking', tool_use: 'Tool', tool_result: 'Result' };

sharePage.get('/:token', (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(req.params.token);
  if (!share || share.expires_at < new Date().toISOString()) {
    return res.status(404).send('<h3 style="font-family:sans-serif">This share link has expired or been revoked.</h3>');
  }
  db.prepare('UPDATE shares SET views = views + 1 WHERE id = ?').run(share.id);
  const messages = JSON.parse(share.content);
  const rows = messages.map((m) => `
    <div class="msg ${m.kind}">
      <div class="head"><b>${KIND_LABEL[m.kind] ?? m.kind}${m.tool_name ? ` · ${esc(m.tool_name)}` : ''}</b>
      <span>${m.ts ? new Date(m.ts).toLocaleString() : ''}</span></div>
      ${m.tool_input ? `<pre class="mono">${esc(clip(m.tool_input, 600))}</pre>` : ''}
      ${m.text ? `<div class="body">${esc(clip(m.text, 4000))}</div>` : ''}
    </div>`).join('\n');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(share.title)}</title>
<meta name="robots" content="noindex"><style>
body{background:#0e1116;color:#dce3ec;font:14px/1.5 -apple-system,sans-serif;max-width:860px;margin:0 auto;padding:24px}
.msg{border:1px solid #2a3340;border-left:3px solid #2a3340;border-radius:8px;padding:8px 12px;margin:8px 0;background:#151a21}
.msg.user{border-left-color:#4f8ef7;background:rgba(79,142,247,.07)}
.msg.thinking{opacity:.7;font-style:italic}
.head{display:flex;justify-content:space-between;font-size:12px;color:#8b98a9;margin-bottom:4px}
.body{white-space:pre-wrap;word-break:break-word}
.mono{font:12px ui-monospace,monospace;color:#8b98a9;white-space:pre-wrap;word-break:break-word;margin:4px 0}
.banner{color:#8b98a9;font-size:12px;border-bottom:1px solid #2a3340;padding-bottom:10px;margin-bottom:14px}
</style></head><body>
<div class="banner">◷ <b>Chronicle</b> shared session — <b>${esc(share.title)}</b> · sensitive content redacted at share time · expires ${new Date(share.expires_at).toLocaleDateString()}</div>
${rows}</body></html>`);
});

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function clip(s, n) { return s.length > n ? s.slice(0, n) + ' …' : s; }
