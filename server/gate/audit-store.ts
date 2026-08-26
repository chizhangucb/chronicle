import { db } from '../db.ts';
import type { AuditRow, AuditStore } from './core.ts';

// Gate audit persistence (CHI-323 D5): a self-created SQLite table, matching
// Chronicle's security_rules / interceptions convention (server/security.ts).
// Varde kept a JSON file; D5 moves it straight to a table (no file-then-migrate).
// Backups (gate-backups/) stay files; only the audit trail is a table.
db.exec(`
CREATE TABLE IF NOT EXISTS gate_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,           -- proposed | confirmed | denied | expired | failed | allowed
  surface TEXT NOT NULL,
  proposal_id TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  reason TEXT,
  diff TEXT,                     -- JSON array of {path, from, to}
  backup TEXT,
  error TEXT,
  detail TEXT                    -- JSON object (allow-class endpoint detail)
);`);

interface GateAuditDbRow {
  ts: string;
  event: string;
  surface: string;
  proposal_id: string;
  actor: string;
  reason: string | null;
  diff: string | null;
  backup: string | null;
  error: string | null;
  detail: string | null;
}

function toAuditRow(r: GateAuditDbRow): AuditRow {
  return {
    ts: r.ts,
    event: r.event as AuditRow['event'],
    surface: r.surface,
    proposalId: r.proposal_id,
    actor: r.actor,
    reason: r.reason ?? '',
    diff: r.diff ? (JSON.parse(r.diff) as AuditRow['diff']) : [],
    ...(r.backup ? { backup: r.backup } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.detail ? { detail: JSON.parse(r.detail) as Record<string, unknown> } : {}),
  };
}

/** The production audit store: the gate_audit table. */
export function sqliteAuditStore(): AuditStore {
  const insert = db.prepare(
    `INSERT INTO gate_audit (ts, event, surface, proposal_id, actor, reason, diff, backup, error, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return {
    append(row: AuditRow): void {
      insert.run(
        row.ts,
        row.event,
        row.surface,
        row.proposalId,
        row.actor,
        row.reason ?? null,
        JSON.stringify(row.diff ?? []),
        row.backup ?? null,
        row.error ?? null,
        row.detail ? JSON.stringify(row.detail) : null,
      );
    },
    read(limit: number): AuditRow[] {
      // newest N, returned chronologically (oldest first) like Varde's file tail
      const rows = db
        .prepare('SELECT * FROM gate_audit ORDER BY id DESC LIMIT ?')
        .all(limit) as unknown as GateAuditDbRow[];
      return rows.reverse().map(toAuditRow);
    },
  };
}
