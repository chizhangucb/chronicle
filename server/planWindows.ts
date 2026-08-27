// server/planWindows.ts (CHI-324 2f) — the Claude subscription rate windows
// (5h / 7d / top-tier-7d) the plan meters, ported from Varde subscription.ts.
//
// OUTBOUND, OPT-IN-OFF (D7): this is the ONE deliberate exception to Chronicle's
// zero-outbound posture. It calls api.anthropic.com/api/oauth/usage — the
// token's own issuer, exactly as Claude Code does — using Claude Code's OAuth
// token (macOS Keychain, else ~/.claude/.credentials.json). It runs ONLY when
// the user turns on `planWindows` in Settings (default OFF); the token is read,
// used for the one request, and never stored or logged.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { readConfig } from './autosync.ts';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 15_000;

export interface PlanWindow { utilization: number; resetsAt: string | null }
export interface PlanWindowsResult {
  /** the Settings opt-in state — false means we never went outbound. */
  enabled: boolean;
  /** true when the token was found and the endpoint answered with windows. */
  available: boolean;
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
  topTier: { label: string; window: PlanWindow } | null;
  fetchedAt: string | null;
}

export function readClaudeToken(home: string = homedir()): string | null {
  if (platform() === 'darwin') {
    const out = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 3_000 });
    const token = parseCredentials(out.status === 0 ? out.stdout : null);
    if (token) return token;
  }
  try { return parseCredentials(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')); }
  catch { return null; }
}

function parseCredentials(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    const token = creds?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token ? token : null;
  } catch { return null; }
}

function parseWindow(raw: unknown): PlanWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as { utilization?: unknown; resets_at?: unknown };
  if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  return { utilization: w.utilization, resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null };
}

export function parsePayload(raw: unknown, fetchedAt: string): Omit<PlanWindowsResult, 'enabled'> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const fiveHour = parseWindow(d.five_hour);
  const sevenDay = parseWindow(d.seven_day);
  // The top-tier 7-day window: whatever the API reports (opus or sonnet) — never
  // hardcode a model name (contract).
  const opus = parseWindow(d.seven_day_opus);
  const sonnet = parseWindow(d.seven_day_sonnet);
  const topTier = opus ? { label: 'opus', window: opus } : sonnet ? { label: 'sonnet', window: sonnet } : null;
  if (!fiveHour && !sevenDay) return null; // no recognizable window = contract change, not data
  return { available: true, fiveHour, sevenDay, topTier, fetchedAt };
}

async function fetchWindows(token: string): Promise<Omit<PlanWindowsResult, 'enabled'> | null> {
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parsePayload(await res.json(), new Date().toISOString());
  } catch { return null; }
}

const ABSENT = (enabled: boolean): PlanWindowsResult => ({ enabled, available: false, fiveHour: null, sevenDay: null, topTier: null, fetchedAt: null });

export async function computePlanWindows(): Promise<PlanWindowsResult> {
  if (readConfig().planWindows !== true) return ABSENT(false); // opt-in-off default
  const token = readClaudeToken();
  if (!token) return ABSENT(true);
  const w = await fetchWindows(token);
  return w ? { enabled: true, ...w } : ABSENT(true);
}
