// Redaction, and only redaction: the rules the operator keeps, the scan over a
// string and the scan over a session. The `security_rules` table itself is
// declared in server/db.ts (issue #264), which is the one place schema lives.
import { db } from './db.ts';
// The rule row, the finding, the scanned message and the scan result are the
// four shapes this engine answers the redaction preview with. They are declared
// in shared/ (#307) so the preview renders what the route sends.
import type { SecurityRuleRow } from '../shared/rows.ts';
import type { SecurityCheckMessage, SecurityFinding, SecurityScanResult } from '../shared/results.ts';

/** A finding before it is attributed to one of a message's two scanned fields
 * — `SecurityFinding` (shared/results.ts) with `field` still to come. */
export type Finding = Omit<SecurityFinding, 'field'>;

export interface ScanTextResult {
  findings: Finding[];
  redacted: string | null | undefined;
}

interface RuleSpec {
  id: string;
  name: string;
  re: RegExp;
  replace: (...args: string[]) => string;
}

// FR-SEC-1: built-in detection rules — meaningful placeholders keep structure readable.
export const BUILTIN_RULES: RuleSpec[] = [
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

export function listRules(): SecurityRuleRow[] {
  return db.prepare('SELECT * FROM security_rules ORDER BY id').all() as unknown as SecurityRuleRow[];
}

export interface RuleInput {
  name?: string | null;
  pattern: string;
  replacement?: string | null;
  kind?: string;
}

export function addRule({ name, pattern, replacement, kind }: RuleInput): void {
  db.prepare('INSERT INTO security_rules (name, pattern, replacement, kind) VALUES (?, ?, ?, ?)')
    .run(name || pattern, pattern, replacement || '****', kind === 'allow' ? 'allow' : 'redact');
}
export function deleteRule(id: number | string): void {
  db.prepare('DELETE FROM security_rules WHERE id = ?').run(id);
}
export function toggleRule(id: number | string, enabled: boolean): void {
  db.prepare('UPDATE security_rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

// Glob → regex: * any length, ? single char (FR-SEC-2)
function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\s]*').replace(/\?/g, '.');
  return new RegExp(esc, 'g');
}

function activeCustomRules(): (SecurityRuleRow & { re: RegExp })[] {
  return listRules().filter((r) => r.enabled).map((r) => {
    try { return { ...r, re: globToRegex(r.pattern) }; } catch { return null; }
  }).filter((r): r is SecurityRuleRow & { re: RegExp } => Boolean(r));
}

// Scan text → findings + redacted text. Priority (FR-SEC-3):
// allow rules protect spans; custom redact rules run before built-ins;
// earlier matches win on overlap.
export function scanText(text: string | null | undefined): ScanTextResult {
  if (!text) return { findings: [], redacted: text };
  const custom = activeCustomRules();
  const allowSpans: [number, number][] = [];
  for (const rule of custom.filter((r) => r.kind === 'allow')) {
    for (const m of text.matchAll(rule.re)) {
      if (m[0] && m.index !== undefined) allowSpans.push([m.index, m.index + m[0].length]);
    }
  }
  const inAllowed = (start: number, end: number) => allowSpans.some(([a, b]) => start >= a && end <= b);

  const findings: Finding[] = [];
  const claimed: [number, number][] = [];
  const overlaps = (s: number, e: number) => claimed.some(([a, b]) => s < b && e > a);

  const ruleSets: RuleSpec[] = [
    ...custom.filter((r) => r.kind === 'redact').map((r): RuleSpec => ({
      id: `custom-${r.id}`, name: r.name, re: r.re, replace: () => r.replacement,
    })),
    ...BUILTIN_RULES,
  ];
  for (const rule of ruleSets) {
    for (const m of text.matchAll(rule.re)) {
      if (m.index === undefined) continue;
      const start = m.index, end = m.index + m[0].length;
      if (!m[0] || inAllowed(start, end) || overlaps(start, end)) continue;
      let replacement: string;
      try { replacement = rule.replace(...[m[0], ...m.slice(1)] as string[]); } catch { replacement = '****'; }
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

export interface ScanMessage {
  seq: number;
  kind: string;
  ts?: string | null;
  tool_name?: string | null;
  text?: string | null;
  tool_input?: string | null;
}

// Scan a whole session's messages (FR-SEC-4 preview payload)
export function scanSession(messages: ScanMessage[]): SecurityScanResult {
  const results: SecurityCheckMessage[] = [];
  const totals: Record<string, number> = {};
  for (const m of messages) {
    const perMessage: (Finding & { field: 'text' | 'tool_input' })[] = [];
    let redactedText = m.text;
    let redactedInput = m.tool_input;
    if (m.text) {
      const r = scanText(m.text);
      redactedText = r.redacted;
      perMessage.push(...r.findings.map((f) => ({ ...f, field: 'text' as const })));
    }
    if (m.tool_input) {
      const r = scanText(m.tool_input);
      redactedInput = r.redacted;
      perMessage.push(...r.findings.map((f) => ({ ...f, field: 'tool_input' as const })));
    }
    if (perMessage.length) {
      for (const f of perMessage) totals[f.ruleName] = (totals[f.ruleName] || 0) + 1;
      results.push({ seq: m.seq, kind: m.kind, ts: m.ts, tool_name: m.tool_name, findings: perMessage, redactedText, redactedInput, originalText: m.text, originalInput: m.tool_input });
    }
  }
  return { messages: results, totals, findingCount: Object.values(totals).reduce((a, b) => a + b, 0) };
}
