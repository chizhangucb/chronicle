import { db, ftsAvailable } from '../db.ts';

// ---- Global search (home command palette) ----
// Empty query → recent sessions ("Recent Access"). Non-empty → LIKE scan over
// message text/tool input, grouped per session with a highlighted snippet.
const SCOPE_KINDS = {
  code: ['tool_use', 'tool_result'],
  chat: ['user', 'assistant', 'thinking'],
};

function snippetAround(text, q, radius = 60) {
  if (!text) return '';
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, i - radius);
  return (start > 0 ? '…' : '') + text.slice(start, i + q.length + radius) + (i + q.length + radius < text.length ? '…' : '');
}

export function mountSearch(app) {
  app.get('/search', (req, res) => {
    const q = (req.query.q || '').trim();
    const scope = req.query.scope || 'all';
    const days = Number(req.query.days) || null;
    const projectId = req.query.project ? Number(req.query.project) : null;
    const cutoff = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
    const kinds = SCOPE_KINDS[scope] || null;

    if (!q) {
      const where = ['1=1'];
      const params = [];
      if (projectId) { where.push('s.project_id = ?'); params.push(projectId); }
      const rows = db.prepare(`SELECT s.id, s.project_id, s.source, s.name, s.summary, s.first_prompt,
          s.started_at, s.ended_at, s.message_count, p.name AS project_name
        FROM sessions s JOIN projects p ON p.id = s.project_id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(s.ended_at, s.started_at) DESC LIMIT 12`).all(...params);
      return res.json({ recent: true, results: rows.map((r) => ({ ...r, matchCount: 0, snippet: '', ts: r.ended_at || r.started_at })) });
    }

    // FTS5 MATCH (phrase query, prefix on the last term) with LIKE fallback when
    // the FTS table is unavailable or the query trips FTS syntax.
    const where = [];
    const params = [];
    if (kinds) { where.push(`m.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    if (projectId) { where.push('s.project_id = ?'); params.push(projectId); }
    if (cutoff) { where.push("COALESCE(s.started_at, '9') >= ?"); params.push(cutoff); }
    const tail = where.length ? ' AND ' + where.join(' AND ') : '';
    const select = `SELECT m.session_id, m.seq, m.kind, m.text, m.tool_name, m.tool_input, m.ts,
        s.project_id, s.source, s.name, s.summary, s.first_prompt, p.name AS project_name
      FROM messages m JOIN sessions s ON s.id = m.session_id JOIN projects p ON p.id = s.project_id`;
    let rows = null;
    if (ftsAvailable) {
      try {
        const ftsQuery = `"${q.replace(/"/g, '""')}"*`;
        rows = db.prepare(`${select}
          JOIN messages_fts f ON f.rowid = m.id
          WHERE f MATCH ?${tail}
          ORDER BY m.ts DESC LIMIT 400`).all(ftsQuery, ...params);
      } catch { rows = null; }
    }
    if (rows === null) {
      const like = `%${q}%`;
      rows = db.prepare(`${select}
        WHERE (m.text LIKE ? OR m.tool_input LIKE ?)${tail}
        ORDER BY m.ts DESC LIMIT 400`).all(like, like, ...params);
    }

    const bySession = new Map();
    for (const r of rows) {
      let e = bySession.get(r.session_id);
      if (!e) {
        e = { id: r.session_id, project_id: r.project_id, source: r.source, name: r.name,
          summary: r.summary, first_prompt: r.first_prompt, project_name: r.project_name,
          matchCount: 0, snippet: '', seq: r.seq, ts: r.ts };
        bySession.set(r.session_id, e);
      }
      e.matchCount++;
      if (!e.snippet) {
        const hay = r.text && r.text.toLowerCase().includes(q.toLowerCase()) ? r.text : (r.tool_input || r.text || '');
        e.snippet = snippetAround(hay, q);
        e.seq = r.seq;
        e.ts = r.ts;
      }
    }
    res.json({ recent: false, results: [...bySession.values()].slice(0, 40) });
  });
}
