// server/planWindows.ts (CHI-324 2f) — the subscription rate windows the plans
// meter, one card per ACCOUNT. Two sources, ported from Varde:
//  - Claude (subscription.ts): OUTBOUND, OPT-IN-OFF (D7). Reads Claude Code's
//    OAuth token (Keychain / ~/.claude/.credentials.json) and calls
//    api.anthropic.com/api/oauth/usage — the token's own issuer, exactly as
//    Claude Code does — for the 5h / 7d / top-tier windows. Runs ONLY when the
//    `planWindows` Settings flag is on. Token read, used once, never stored.
//  - Codex (spend-codex.ts): LOCAL, no network. Reads the newest `rate_limits`
//    payload from ~/.codex/sessions rollout logs (primary/secondary windows).
//    Always available (no opt-in — it never leaves the machine).
// The accounts array is adaptive: today the local stores expose one Claude
// account + one Codex account; more cards appear if more become readable.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { readConfig } from './autosync.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 15_000;

export interface AccountWindow { label: string; utilization: number; resetsAt: string | null }
export interface PlanAccount { name: string; kind: 'claude' | 'codex'; plan: string | null; windows: AccountWindow[] }
export interface PlanWindowsResult {
  /** Claude opt-in state — false means we never went outbound. */
  claudeEnabled: boolean;
  /** true when Claude opt-in is on but no readable credential was found. */
  claudeUnauthed: boolean;
  accounts: PlanAccount[];
}

// ---- Claude (outbound, opt-in) ----
function readClaudeToken(home: string = homedir()): string | null {
  if (platform() === 'darwin') {
    const out = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 3_000 });
    const t = parseClaudeCreds(out.status === 0 ? out.stdout : null);
    if (t) return t;
  }
  try { return parseClaudeCreds(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')); }
  catch { return null; }
}
function parseClaudeCreds(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    const t = c?.claudeAiOauth?.accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch { return null; }
}
// The `limits` array is the clean, LABELED source (mirrors Anthropic's own
// desktop/CLI usage view): one entry per window with a kind, a percent, a
// reset, and — for the top-tier — the model's display_name (e.g. "Fable"), so
// the top-tier label follows the API verbatim, never hardcoded.
interface ClaudeLimit { kind?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } } }
export function parseClaudePayload(raw: unknown): PlanAccount | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as { limits?: unknown; subscription_type?: unknown };
  const windows: AccountWindow[] = [];
  for (const item of Array.isArray(d.limits) ? d.limits : []) {
    const l = item as ClaudeLimit;
    if (typeof l.percent !== 'number' || !Number.isFinite(l.percent)) continue;
    const display = l.scope?.model?.display_name;
    let label: string | null;
    if (l.kind === 'session') label = '5h';
    else if (l.kind === 'weekly_all') label = '7d';
    else if (typeof display === 'string' && display) label = display; // e.g. "Fable"
    else if (l.kind === 'weekly_scoped') label = 'top-tier';
    else label = null; // unknown kind → skip (a new window type is not a contract break)
    if (label) windows.push({ label, utilization: l.percent, resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null });
  }
  if (!windows.length) return null; // no recognizable window = contract change
  const plan = typeof d.subscription_type === 'string' ? d.subscription_type : null;
  return { name: 'Claude', kind: 'claude', plan, windows };
}
async function fetchClaude(token: string): Promise<PlanAccount | null> {
  try {
    const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return parseClaudePayload(await res.json());
  } catch { return null; }
}

// ---- Codex (local, no opt-in) ----
const CODEX_DIR = join(homedir(), '.codex', 'sessions');
function walkJsonl(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let entries: import('node:fs').Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
function codexLabel(windowMinutes: number | null): string {
  if (windowMinutes === 300) return '5h';
  if (windowMinutes === 10080) return '7d';
  if (windowMinutes && windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
  if (windowMinutes) return `${Math.round(windowMinutes / 60)}h`;
  return '7d';
}
function codexRateWindow(raw: unknown): AccountWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
  if (typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null;
  return {
    label: codexLabel(typeof w.window_minutes === 'number' ? w.window_minutes : null),
    utilization: w.used_percent,
    resetsAt: typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? new Date(w.resets_at * 1000).toISOString() : null,
  };
}
function readCodexAccount(): PlanAccount | null {
  const files = walkJsonl(CODEX_DIR);
  if (!files.length) return null;
  files.sort((a, b) => { try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; } });
  for (const f of files.slice(0, 6)) { // newest few
    let lines: string[];
    try { lines = readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('rate_limits')) continue;
      try {
        const obj = JSON.parse(lines[i]) as { payload?: { rate_limits?: unknown }; rate_limits?: unknown };
        const rl = (obj.payload?.rate_limits ?? obj.rate_limits) as { primary?: unknown; secondary?: unknown; plan_type?: unknown } | undefined;
        if (!rl) continue;
        const windows: AccountWindow[] = [];
        const primary = codexRateWindow(rl.primary); if (primary) windows.push(primary);
        const secondary = codexRateWindow(rl.secondary); if (secondary) windows.push(secondary);
        if (!windows.length) continue;
        return { name: 'Codex', kind: 'codex', plan: typeof rl.plan_type === 'string' ? rl.plan_type : null, windows };
      } catch { /* not this line */ }
    }
  }
  return null;
}

/**
 * Synthetic plan windows for demo mode (CHI-325 3c).
 *
 * HARD REQUIREMENT, not a nicety: this is the only outbound call Chronicle
 * makes, and a demo console must make none. Demo is what a stranger runs to
 * see the product, and it would be indefensible for that to reach out to
 * Anthropic with (or without) their token. Demo therefore returns fabricated
 * meters and NEVER reaches fetchClaude or readClaudeToken.
 */
function demoPlanWindows(): PlanWindowsResult {
  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  return {
    claudeEnabled: true,
    claudeUnauthed: false,
    accounts: [
      {
        name: 'demo@chronicle', kind: 'claude', plan: 'Max',
        windows: [
          { label: '5h', utilization: 0.42, resetsAt: hoursFromNow(2.5) },
          { label: '7d', utilization: 0.61, resetsAt: hoursFromNow(52) },
          { label: 'fable', utilization: 0.28, resetsAt: hoursFromNow(52) },
        ],
      },
      {
        name: 'demo (codex)', kind: 'codex', plan: 'Pro',
        windows: [{ label: '7d', utilization: 0.35, resetsAt: hoursFromNow(88) }],
      },
    ],
  };
}

export async function computePlanWindows(): Promise<PlanWindowsResult> {
  if (process.env.CHRONICLE_DEMO === '1') return demoPlanWindows();
  const accounts: PlanAccount[] = [];
  // Codex: local, always (never outbound).
  const codex = readCodexAccount();
  if (codex) accounts.push(codex);
  // Claude: outbound, opt-OUT (default ON — reads your own quota from the token's
  // own issuer, like Claude Code; turn off in Settings). Codex above stays local.
  const claudeEnabled = readConfig().planWindows !== false;
  let claudeUnauthed = false;
  if (claudeEnabled) {
    const token = readClaudeToken();
    if (!token) claudeUnauthed = true;
    else { const claude = await fetchClaude(token); if (claude) accounts.unshift(claude); else claudeUnauthed = true; }
  }
  return { claudeEnabled, claudeUnauthed, accounts };
}
