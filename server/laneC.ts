// server/laneC.ts
// Lane C = the LiteLLM proxy spend log (~/.aios/litellm/spend.jsonl). It is the
// AUTHORITATIVE billed-dollar record for proxy-routed models, but it carries
// only model + time dims (no session/project/cwd), so it can never be a session
// "source" the way claude-code/codex are. We surface it as a standalone "Proxy
// lane (billed)" KPI tile, NEVER merged into the session-derived spend/tokens
// (those are Chronicle's own client-side estimates; mixing the two would double
// the authority story). Live-read on each request — the log is tiny.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SPEND_PATH = join(homedir(), '.aios', 'litellm', 'spend.jsonl');

export interface LaneCModel { model: string; spend: number; requests: number; tokens: number; }
export interface LaneCSpend { totalSpend: number; requests: number; byModel: LaneCModel[]; }

const EMPTY: LaneCSpend = { totalSpend: 0, requests: 0, byModel: [] };

// One spend.jsonl row. The schema DRIFTS (newer rows added provider/latency_ms),
// so read only the four fields we need and ignore the rest.
interface SpendRow { startTime?: string; model?: string; spend?: number; total_tokens?: number; }

// Aggregate proxy spend by model, optionally filtered to rows at/after cutoffIso
// (ISO string). Missing file → empty (no throw); malformed lines are skipped.
// `path` is injectable for tests; production always uses the default log path.
export function readLaneCSpend(cutoffIso: string | null = null, path: string = SPEND_PATH): LaneCSpend {
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
