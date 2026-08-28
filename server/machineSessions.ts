// server/machineSessions.ts
// The hub writes ~/.aios/machine_sessions.jsonl, append-only, one row per
// headless machine `claude -p` spawn (weekly/nightly/session-close/spend-advice
// jobs). These are AUTOMATION sessions, not interactive Claude Code sessions.
// Chronicle reads them so it can (1) exclude their session_ids from the
// headline INTERACTIVE session count, and (2) surface their spend as a separate
// automation bucket attributed by `job` (CHI-233 Part C).
//
// Same server-ships-cells / client-prices split the rest of Chronicle uses (the
// price table lives ONLY in src/models.ts): we ship each session's raw token
// CELLS, not a dollar figure, so the client prices them via costOf. `cost_usd`
// travels only as a convenience fallback for a client that has no price for the
// model. A session whose transcript IS present in the scan is deduped OUT on the
// client (transcript wins) — this reader never decides that; it just surfaces
// the manifest verbatim. Live-read on each request — the log is tiny.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiosRoot } from './demo/paths.ts';

// Resolved per call: in demo the root points into the seeded demo directory
// (server/demo/paths.ts), which is only known once CHRONICLE_DATA_DIR is set.
const manifestPath = (): string => join(aiosRoot(), 'machine_sessions.jsonl');

// Mirrors the cell shape the rest of the pipeline uses (server/windowUsage.ts
// UsageCells). The manifest's canonical usage has ONE combined cache-write key
// (cache_write_tokens); we map it to the 5-minute tier (cacheWrite5m), matching
// the legacy convention already in src/models.ts / server/windowUsage.ts.
export interface MachineUsageCells {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface MachineSession {
  sessionId: string;
  job: string;
  model: string | null;
  usage: MachineUsageCells;
  cost_usd: number | null;
  ts: string | null;
}

export interface MachineSessionsResult {
  // The set of manifest session_ids in range — the client's exclusion set for
  // the interactive session count.
  ids: string[];
  // Per-session job/model/usage/cost, for the automation bucket.
  sessions: MachineSession[];
}

const EMPTY: MachineSessionsResult = { ids: [], sessions: [] };

// One manifest row (contract; extra fields tolerated/ignored). `usage` is
// normalized to the 4 canonical keys by the hub.
interface ManifestUsage {
  input_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  output_tokens?: number;
}
interface ManifestRow {
  session_id?: string;
  job?: string;
  ts?: string;
  model?: string;
  usage?: ManifestUsage;
  cost_usd?: number | null;
}

function normalizeUsage(u: ManifestUsage | undefined): MachineUsageCells {
  return {
    input: Number(u?.input_tokens) || 0,
    output: Number(u?.output_tokens) || 0,
    cacheRead: Number(u?.cache_read_tokens) || 0,
    cacheWrite5m: Number(u?.cache_write_tokens) || 0,
    cacheWrite1h: 0,
  };
}

// Read the machine-session manifest, optionally filtered to rows at/after
// cutoffIso (ISO string). Missing file → empty (no throw); malformed lines are
// skipped; rows with no session_id are skipped (nothing to attribute or dedup
// on). `path` is injectable for tests; production always uses the default path.
export function readMachineSessions(cutoffIso: string | null = null, path: string = manifestPath()): MachineSessionsResult {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return { ids: [], sessions: [] }; }

  // Keyed by session_id, LAST row wins. The manifest is append-only, so a
  // re-spawned or retried job can write the same session_id more than once —
  // and these cells are priced straight into the Spend tile's automation
  // bucket, so an unguarded second row bills that run twice. Same defect class
  // as CHI-286 (aggregating a billed magnitude with no per-call identity), found
  // by that ticket's sweep. Last-wins because a rerun's final report supersedes
  // the earlier one, unlike a replayed transcript line where max is correct.
  const byId = new Map<string, MachineSession>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: ManifestRow;
    try { r = JSON.parse(line) as ManifestRow; } catch { continue; }
    if (!r.session_id) continue;
    // Lexicographic compare is safe for fixed-width ISO-8601 UTC strings (string
    // order == chronological), same assumption server/laneC.ts documents.
    if (cutoffIso && (r.ts ?? '') < cutoffIso) continue;
    byId.set(r.session_id, {
      sessionId: r.session_id,
      job: r.job ?? 'unknown',
      model: r.model ?? null,
      usage: normalizeUsage(r.usage),
      cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
      ts: r.ts ?? null,
    });
  }
  if (!byId.size) return { ...EMPTY };
  const sessions = [...byId.values()];
  return { ids: sessions.map((s) => s.sessionId), sessions };
}
