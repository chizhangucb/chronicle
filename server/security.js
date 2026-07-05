import { db } from './db.js';

db.exec(`
CREATE TABLE IF NOT EXISTS security_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  pattern TEXT NOT NULL,          -- glob: * = any length, ? = single char
  replacement TEXT DEFAULT '****',
  kind TEXT NOT NULL DEFAULT 'redact',  -- 'redact' | 'allow'
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin_override TEXT           -- if set, disables that builtin rule id
);`);

db.exec(`
CREATE TABLE IF NOT EXISTS interceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  tool_name TEXT,
  file_path TEXT,
  rules TEXT,          -- JSON array of matched rule names
  sample TEXT,         -- first blocked match (truncated)
  action TEXT          -- 'blocked' | 'flagged'
);`);

// Rules that justify hard-blocking a tool call (vs. merely flagging).
const HIGH_SEVERITY = new Set(['api_key', 'password', 'token', 'db_conn']);

// FR-SEC-1: built-in detection rules — meaningful placeholders keep structure readable.
export const BUILTIN_RULES = [
  {
    id: 'api_key', name: 'API keys',
    re: /\b(sk-[A-Za-z0-9_-]{8,}|anthropic-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})/g,
    replace: (m) => m.slice(0, m.indexOf('-') + 1 || 3) + '****',
  },
  {
    id: 'password', name: 'Passwords',
    re: /((?:password|passwd|pwd|secret)["']?\s*[:=]\s*["']?)([^\s"',;]{3,})/gi,
    replace: (_, pre) => pre + '****',
  },
  {
    id: 'token', name: 'Bearer / JWT tokens',
    re: /(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}=*|\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}/g,
    replace: (m, bearer) => (bearer ? bearer + '****' : 'eyJ****'),
  },
  {
    // more specific than email/password — must run before them (FR-SEC-3)
    id: 'db_conn', name: 'DB connection strings',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|mssql):\/\/[^\s"'<>]+/gi,
    replace: () => '****',
  },
  {
    id: 'email', name: 'Email addresses',
    re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
    replace: () => '***@***.com',
  },
  {
    id: 'phone', name: 'Phone numbers',
    re: /(?<![\d.\w])\+?\d{1,3}[-. ()]{1,2}\d{3}[-. ()]{1,2}\d{3,4}[-. ]\d{3,4}(?![\d.])/g,
    replace: () => '***-***-****',
  },
  {
    id: 'private_ip', name: 'Private IP addresses',
    re: /\b(?:10\.\d{1,3}|127\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2}\b/g,
    replace: () => '***.***.***.***',
  },
];

export function listRules() {
  return db.prepare('SELECT * FROM security_rules ORDER BY id').all();
}
export function addRule({ name, pattern, replacement, kind }) {
  db.prepare('INSERT INTO security_rules (name, pattern, replacement, kind) VALUES (?, ?, ?, ?)')
    .run(name || pattern, pattern, replacement || '****', kind === 'allow' ? 'allow' : 'redact');
}
export function deleteRule(id) {
  db.prepare('DELETE FROM security_rules WHERE id = ?').run(id);
}
export function toggleRule(id, enabled) {
  db.prepare('UPDATE security_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

// Glob → regex: * any length, ? single char (FR-SEC-2)
function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\s]*').replace(/\?/g, '.');
  return new RegExp(esc, 'g');
}

function activeCustomRules() {
  return listRules().filter((r) => r.enabled).map((r) => {
    try { return { ...r, re: globToRegex(r.pattern) }; } catch { return null; }
  }).filter(Boolean);
}

// Scan text → findings + redacted text. Priority (FR-SEC-3):
// allow rules protect spans; custom redact rules run before built-ins;
// earlier matches win on overlap.
export function scanText(text) {
  if (!text) return { findings: [], redacted: text };
  const custom = activeCustomRules();
  const allowSpans = [];
  for (const rule of custom.filter((r) => r.kind === 'allow')) {
    for (const m of text.matchAll(rule.re)) {
      if (m[0]) allowSpans.push([m.index, m.index + m[0].length]);
    }
  }
  const inAllowed = (start, end) => allowSpans.some(([a, b]) => start >= a && end <= b);

  const findings = [];
  const claimed = [];
  const overlaps = (s, e) => claimed.some(([a, b]) => s < b && e > a);

  const ruleSets = [
    ...custom.filter((r) => r.kind === 'redact').map((r) => ({
      id: `custom-${r.id}`, name: r.name, re: r.re, replace: () => r.replacement,
    })),
    ...BUILTIN_RULES,
  ];
  for (const rule of ruleSets) {
    for (const m of text.matchAll(rule.re)) {
      const start = m.index, end = m.index + m[0].length;
      if (!m[0] || inAllowed(start, end) || overlaps(start, end)) continue;
      let replacement;
      try { replacement = rule.replace(...[m[0], ...m.slice(1)]); } catch { replacement = '****'; }
      findings.push({ rule: rule.id, ruleName: rule.name, match: m[0], start, end, replacement });
      claimed.push([start, end]);
    }
  }
  findings.sort((a, b) => a.start - b.start);
  let redacted = '';
  let cursor = 0;
  for (const f of findings) {
    redacted += text.slice(cursor, f.start) + f.replacement;
    cursor = f.end;
  }
  redacted += text.slice(cursor);
  return { findings, redacted };
}

// Pre-tool-use detection (FR-SEC-5): scan tool content BEFORE it reaches the
// model. For Read-like tools we scan the actual file contents; otherwise the
// tool input itself. Only high-severity findings block; the rest are flagged.
export function preToolUseCheck({ tool_name, tool_input }, readFileFn) {
  const input = typeof tool_input === 'string' ? safeParse(tool_input) : (tool_input ?? {});
  let content = '';
  let filePath = input.file_path || input.path || null;
  if (filePath && /^(Read|read_file|View|Grep|NotebookRead)$/i.test(tool_name || '') && readFileFn) {
    content = readFileFn(filePath) ?? '';
  } else {
    content = JSON.stringify(input);
  }
  const { findings } = scanText(content);
  if (!findings.length) return { decision: 'allow', findings: [] };
  const blocking = findings.filter((f) => HIGH_SEVERITY.has(f.rule) || f.rule.startsWith('custom-'));
  const action = blocking.length ? 'blocked' : 'flagged';
  db.prepare('INSERT INTO interceptions (tool_name, file_path, rules, sample, action) VALUES (?, ?, ?, ?, ?)')
    .run(tool_name ?? null, filePath, JSON.stringify([...new Set(findings.map((f) => f.ruleName))]),
         (blocking[0] ?? findings[0]).match.slice(0, 80), action);
  return {
    decision: blocking.length ? 'block' : 'allow',
    action,
    findings: findings.map((f) => ({ rule: f.ruleName, match: f.match.slice(0, 60) })),
    reason: blocking.length
      ? `Chronicle blocked this tool call: ${blocking.length} high-risk secret(s) detected (${[...new Set(blocking.map((f) => f.ruleName))].join(', ')})${filePath ? ` in ${filePath}` : ''}. Redact or allowlist via Chronicle → Security before retrying.`
      : null,
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

export function listInterceptions(limit = 200) {
  return db.prepare('SELECT * FROM interceptions ORDER BY id DESC LIMIT ?').all(limit);
}

// Scan a whole session's messages (FR-SEC-4 preview payload)
export function scanSession(messages) {
  const results = [];
  const totals = {};
  for (const m of messages) {
    const fields = [m.text, m.tool_input].filter(Boolean);
    const perMessage = [];
    let redactedText = m.text;
    let redactedInput = m.tool_input;
    if (m.text) {
      const r = scanText(m.text);
      redactedText = r.redacted;
      perMessage.push(...r.findings.map((f) => ({ ...f, field: 'text' })));
    }
    if (m.tool_input) {
      const r = scanText(m.tool_input);
      redactedInput = r.redacted;
      perMessage.push(...r.findings.map((f) => ({ ...f, field: 'tool_input' })));
    }
    if (perMessage.length) {
      for (const f of perMessage) totals[f.ruleName] = (totals[f.ruleName] || 0) + 1;
      results.push({ seq: m.seq, kind: m.kind, ts: m.ts, tool_name: m.tool_name, findings: perMessage, redactedText, redactedInput, originalText: m.text, originalInput: m.tool_input });
    }
  }
  return { messages: results, totals, findingCount: Object.values(totals).reduce((a, b) => a + b, 0) };
}
