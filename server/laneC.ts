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
import { resolveDataDir, expandTilde } from './dataDir.ts';

// Legacy location: the log lived under ~/.aios before the proxy runtime was
// de-hubbed (issue #186). Read ALONGSIDE the current one rather than instead of
// it, so an operator with history keeps it the moment the new log appears.
const legacyPath = (): string => join(homedir(), '.aios', 'litellm', 'spend.jsonl');

/**
 * Where a spend row LANDS. The same resolution the producer uses
 * (litellm/lane_c_spend_logger.py `default_spend_path`), so a fresh clone lines
 * the two up with no configuration:
 *   1. demo pins its own dir, and nothing else is consulted, so a demo console
 *      can never read the operator's real log whatever their shell exports
 *   2. $LANE_C_SPEND_LOG (tilde expanded, as the producer expands it)
 *   3. <data dir>/litellm/spend.jsonl, the same root server/db.ts uses
 * Resolved per call rather than at module load: in demo mode CHRONICLE_DATA_DIR
 * is only known once the demo dir is seeded.
 */
export function laneCSpendPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHRONICLE_DEMO === '1' && env.CHRONICLE_DATA_DIR) {
    return join(env.CHRONICLE_DATA_DIR, 'litellm', 'spend.jsonl');
  }
  const override = env.LANE_C_SPEND_LOG?.trim();
  if (override) return expandTilde(override);
  return join(resolveDataDir(env), 'litellm', 'spend.jsonl');
}

/**
 * Every log the READERS below aggregate: the current one, plus the pre-#186
 * `~/.aios` log while it is still there. Reading both is what makes the move
 * lossless; resolving to one or the other would silently drop months of billed
 * history the first time the new log came into existence.
 *
 * Only demo and an explicit LANE_C_SPEND_LOG suppress the legacy read. A plain
 * CHRONICLE_DATA_DIR does NOT: relocating the data dir is ordinary (server/db.ts
 * honours it, and the launchd job pins it), so treating it as "pinned" would
 * strip the history from exactly the operator most likely to have some.
 */
export function laneCSpendPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const current = laneCSpendPath(env);
  const pinned = env.CHRONICLE_DEMO === '1' || !!env.LANE_C_SPEND_LOG?.trim();
  if (pinned) return [current];
  const legacy = legacyPath();
  return existsSync(legacy) ? [current, legacy] : [current];
}

/** Every readable log's text, in resolution order. A missing file contributes
 *  nothing (the log simply does not exist yet); it is never an error. */
function spendText(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    try { out.push(readFileSync(p, 'utf8')); } catch { /* not there yet */ }
  }
  return out;
}

export interface LaneCModel { model: string; spend: number; requests: number; tokens: number; }
export interface LaneCSpend { totalSpend: number; requests: number; byModel: LaneCModel[]; }

const EMPTY: LaneCSpend = { totalSpend: 0, requests: 0, byModel: [] };

// One spend.jsonl row. The schema DRIFTS (newer rows added provider/latency_ms),
// so read only the four fields we need and ignore the rest.
interface SpendRow { startTime?: string; model?: string; spend?: number; total_tokens?: number; }

// Aggregate proxy spend by model, optionally filtered to rows at/after cutoffIso
// (ISO string). Missing file → empty (no throw); malformed lines are skipped.
// `paths` is injectable for tests; production reads every log
// laneCSpendPaths() names.
export function readLaneCSpend(cutoffIso: string | null = null, paths: string[] = laneCSpendPaths()): LaneCSpend {
  const texts = spendText(paths);
  if (!texts.length) return { ...EMPTY, byModel: [] };

  const byModel = new Map<string, LaneCModel>();
  let totalSpend = 0;
  let requests = 0;
  for (const line of texts.join('\n').split('\n')) {
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
export function readLaneCDailyCost(cutoffIso: string | null = null, paths: string[] = laneCSpendPaths()): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of spendText(paths).join('\n').split('\n')) {
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
