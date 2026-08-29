// Hub-file touches from session transcripts (CHI-385): every Read/Edit/Write of
// a file under the hub root becomes a { ts, path } touch that feeds the memory
// graph's Usage lane (and the rot "unused" test + the orphan-in-window
// derivation). The touched path is NOT a stored column; it lives inside
// messages.tool_input JSON, extracted at read time the same way causality.ts
// does. Relative paths (Cursor/OpenCode write cwd-relative) resolve against the
// session cwd (projects.path). Absolute hub paths only.
import path from 'node:path';
import { db } from '../../db.ts';

// The tools whose input names a file the session actually read or wrote. Mirrors
// causality.ts's READ_TOOLS + CHANGE_TOOLS (a touch is any of them), plus the
// notebook variants the extractor already understands.
const TOUCH_TOOLS = [
  'Read', 'Edit', 'Write', 'NotebookRead', 'NotebookEdit',
  'read_file', 'edit_file', 'write_file', 'View', 'cat',
];

/** The touched path from a tool_input blob (file_path / path / notebook_path),
 * or null. Same shape causality.ts:extractPath reads. */
function extractPath(inputJson: string | null): string | null {
  try {
    const input = JSON.parse(inputJson || '{}');
    return input.file_path || input.path || input.notebook_path || null;
  } catch {
    return null;
  }
}

interface TouchRow { ts: string | null; input: string | null; cwd: string | null }

export function collectHubFileTouches(hubRoot: string): { ts: number; path: string }[] {
  const root = path.resolve(hubRoot);
  // Cheap SQL prefilter: only tool_use rows whose input text mentions the hub
  // dir name can name a hub file. The exact under-root test is done in JS below.
  const base = path.basename(root);
  const placeholders = TOUCH_TOOLS.map(() => '?').join(',');
  let rows: TouchRow[];
  try {
    rows = db.prepare(
      `SELECT m.ts AS ts, m.tool_input AS input, p.path AS cwd
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         JOIN projects p ON p.id = s.project_id
        WHERE m.kind = 'tool_use'
          AND m.tool_name IN (${placeholders})
          AND m.tool_input LIKE ?`,
    ).all(...TOUCH_TOOLS, `%${base}%`) as unknown as TouchRow[];
  } catch {
    return []; // a shape mismatch or missing table must never wedge the slice
  }

  const out: { ts: number; path: string }[] = [];
  for (const r of rows) {
    const raw = extractPath(r.input);
    if (!raw) continue;
    const abs = path.isAbsolute(raw) ? raw : (r.cwd ? path.resolve(r.cwd, raw) : null);
    if (!abs) continue;
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside the hub
    const ts = r.ts ? Date.parse(r.ts) : Number.NaN;
    if (Number.isFinite(ts)) out.push({ ts, path: abs });
  }
  return out;
}

/** A cheap signature for the memory-slice cache key: it changes when sessions
 * are imported or grow, so the (heavy) slice recomputes its touches after new
 * work lands, without the LIKE scan running on every request. Reads only the
 * small sessions table. */
export function hubTouchSignature(): string {
  try {
    const r = db.prepare(
      `SELECT COUNT(*) AS n, MAX(imported_at) AS last, SUM(message_count) AS msgs FROM sessions`,
    ).get() as { n: number; last: string | null; msgs: number | null };
    return `${r?.n ?? 0}:${r?.last ?? ''}:${r?.msgs ?? 0}`;
  } catch {
    return '0';
  }
}
