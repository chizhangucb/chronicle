import type { Express, Request, Response } from 'express';
import { db, type SessionRow, type ProjectRow, type MessageRow } from '../db.ts';
import { scanSession, listRules, addRule, deleteRule, toggleRule } from '../security.ts';

const LABEL: Record<string, string> = { user: 'User', assistant: 'Assistant', thinking: 'Thinking', tool_use: 'Tool call', tool_result: 'Tool result' };

export function mountSecurity(app: Express): void {
  // ---- Security: scan, rules, redacted export ----

  app.get('/sessions/:id/security-check', (req: Request, res: Response) => {
    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all((req.params.id as string)) as unknown as MessageRow[];
    if (!messages.length) return res.status(404).json({ error: 'Session not found or empty' });
    res.json(scanSession(messages));
  });

  // One-way redacted export (FR-SEC-7/8): original DB rows are never modified.
  app.get('/sessions/:id/export-redacted', (req: Request, res: Response) => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get((req.params.id as string)) as SessionRow | undefined;
    if (!session) return res.status(404).json({ error: 'Not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id) as unknown as ProjectRow;
    const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY seq').all(session.id) as unknown as MessageRow[];
    const scan = scanSession(messages);
    const redactedBySeq = new Map(scan.messages.map((m) => [m.seq, m]));
    const lines = [`# ${project.name} — session export (redacted)`, '',
      `> ${session.source} · ${session.started_at ?? ''} · ${messages.length} messages · ${scan.findingCount} redactions`, ''];
    for (const m of messages) {
      const r = redactedBySeq.get(m.seq);
      const text = r ? r.redactedText : m.text;
      const input = r ? r.redactedInput : m.tool_input;
      lines.push(`### ${LABEL[m.kind] || m.kind}${m.tool_name ? ` — ${m.tool_name}` : ''}`, '');
      if (input) lines.push('```json', input, '```', '');
      if (text) lines.push(text, '');
    }
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name}-redacted.md"`);
    res.send(lines.join('\n'));
  });

  app.get('/security/rules', (_req: Request, res: Response) => res.json(listRules()));
  app.post('/security/rules', (req: Request, res: Response) => {
    const { name, pattern, replacement, kind } = req.body;
    if (!pattern) return res.status(400).json({ error: 'pattern required' });
    addRule({ name, pattern, replacement, kind });
    res.json(listRules());
  });
  app.delete('/security/rules/:id', (req: Request, res: Response) => { deleteRule((req.params.id as string)); res.json(listRules()); });
  app.patch('/security/rules/:id', (req: Request, res: Response) => { toggleRule((req.params.id as string), !!req.body.enabled); res.json(listRules()); });
}
