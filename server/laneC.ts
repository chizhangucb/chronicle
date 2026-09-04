// server/laneC.ts
// Lane C = the LiteLLM proxy spend log this repo's own proxy writes
// (litellm/lane_c_spend_logger.py). It is the AUTHORITATIVE billed-dollar
// record for proxy-routed models, but it carries
// only model + time dims (no session/project/cwd), so it can never be a session
// "source" the way claude-code/codex are. We surface it as a standalone "Proxy
// lane (billed)" KPI tile, NEVER merged into the session-derived spend/tokens
// (those are Chronicle's own client-side estimates; mixing the two would double
// the authority story). Live-read on each request — the log is tiny.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Legacy location: the log lived under ~/.aios before the proxy runtime was
// de-hubbed (issue #186). Still read when it is the only one present, so an
// operator with history does not lose it on upgrade.
const legacyPath = (): string => join(homedir(), '.aios', 'litellm', 'spend.jsonl');

/**
 * Where the spend log lives. The SAME resolution the producer uses
 * (litellm/lane_c_spend_logger.py `default_spend_path`), so a fresh clone lines
 * the two up with no configuration:
 *   1. $LANE_C_SPEND_LOG
 *   2. <$CHRONICLE_DATA_DIR or ~/.chronicle>/litellm/spend.jsonl
 *   3. the legacy ~/.aios copy, but only when no data dir is pinned (demo mode
 *      pins one, so demo can never read the operator's real files) and the
 *      current location does not exist yet.
 * Resolved per call rather than at module load: in demo mode CHRONICLE_DATA_DIR
 * is only known once the demo dir is seeded.
 */
export function laneCSpendPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LANE_C_SPEND_LOG?.trim();
  if (override) return override;
  if (env.CHRONICLE_DATA_DIR) return join(env.CHRONICLE_DATA_DIR, 'litellm', 'spend.jsonl');
  const current = join(homedir(), '.chronicle', 'litellm', 'spend.jsonl');
  if (existsSync(current)) return current;
  return existsSync(legacyPath()) ? legacyPath() : current;
}

const spendPath = (): string => laneCSpendPath();

export interface LaneCModel { model: string; spend: number; requests: number; tokens: number; }
export interface LaneCSpend { totalSpend: number; requests: number; byModel: LaneCModel[]; }

const EMPTY: LaneCSpend = { totalSpend: 0, requests: 0, byModel: [] };

// One spend.jsonl row. The schema DRIFTS (newer rows added provider/latency_ms),
// so read only the four fields we need and ignore the rest.
interface SpendRow { startTime?: string; model?: string; spend?: number; total_tokens?: number; }

// Aggregate proxy spend by model, optionally filtered to rows at/after cutoffIso
// (ISO string). Missing file → empty (no throw); malformed lines are skipped.
// `path` is injectable for tests; production always uses the default log path.
export function readLaneCSpend(cutoffIso: string | null = null, path: string = spendPath()): LaneCSpend {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return { ...EMPTY, byModel: [] }; }

  const byModel = new Map<string, LaneCModel>();
  let totalSpend = 0;
  let requests = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: SpendRow;
    try { r = JSON.parse(line) as SpendRow; } catch { continue; }
    // Lexicographic compare is safe because both sides are fixed-width UTC-Z
    // ISO strings (string order == chronological). If LiteLLM ever emitted
    // offset/local timestamps this would mis-filter (wrong-inclusion, never a
    // crash) — revisit if the log format changes.
    if (cutoffIso && (r.startTime ?? '') < cutoffIso) continue;
    const model = r.model ?? 'unknown';
    const spend = Number(r.spend) || 0;
    const tokens = Number(r.total_tokens) || 0;
    const m = byModel.get(model) ?? { model, spend: 0, requests: 0, tokens: 0 };
    m.spend += spend; m.requests += 1; m.tokens += tokens;
    byModel.set(model, m);
    totalSpend += spend;
    requests += 1;
  }
  return { totalSpend, requests, byModel: [...byModel.values()].sort((a, b) => b.spend - a.spend) };
}

// Local-calendar-day key (YYYY-MM-DD) for an ISO timestamp, matching the
// server's `strftime(..., 'localtime')` convention used everywhere else.
function localDayKey(iso: string): string | null {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms === 0) return null;
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Per-day proxy-lane spend (CHI-324 D8): the authoritative billed dollars Lane C
// contributes to a day, keyed by LOCAL calendar day. Ported from Varde's
// laneCDailyCost. Used to FOLD Lane C into HEADLINE totals + the anomaly ratio
// (budget/anomaly only make sense over the true total) — but NEVER smeared
// across session-level analytics, and Lane C is never an anomaly dimension
// mover (it is unattributable; see LANE_C_UNATTRIBUTED_DEFINITION). Token-only
// rows (no `spend`) add 0 — never a guessed dollar. Rows without a usable
// startTime are dropped (cannot be placed on a day). Cost kept unrounded (Lane
// C spend is routinely sub-cent).
export function readLaneCDailyCost(cutoffIso: string | null = null, path: string = spendPath()): Map<string, number> {
  const out = new Map<string, number>();
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: SpendRow;
    try { r = JSON.parse(line) as SpendRow; } catch { continue; }
    if (cutoffIso && (r.startTime ?? '') < cutoffIso) continue;
    if (!r.startTime) continue;
    const day = localDayKey(r.startTime);
    if (!day) continue;
    out.set(day, (out.get(day) ?? 0) + (Number(r.spend) || 0));
  }
  return out;
}
