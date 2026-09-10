// server/config.ts
// One definition of Chronicle's data folder and one reader and writer for the
// config.json inside it (issue #303, audit F6). Nothing else joins homedir()
// with its own copy of the rule and nothing else parses the file.
//
// This module imports nothing of Chronicle's, on purpose: the noise gate needs
// the config and is itself imported by db.ts, so a config reader that reached
// for db.ts or autosync.ts would close an import cycle. That cycle is why the
// gate used to carry a private reader.
//
// The folder is frozen at import time, because server/db.ts binds its database
// handle then: a later change to $CHRONICLE_DATA_DIR would move the config
// without moving the database.
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything the operator can set in `config.json`. */
export interface ChronicleConfig {
  autoSync?: boolean;
  autoSyncPaused?: boolean;
  // Spend-tab Claude Plan windows, default ON (opt-OUT). The
  // ONE outbound call in Chronicle: reads the user's own Claude quota from
  // api.anthropic.com (the token's own issuer, like Claude Code). Set false for a
  // fully offline instance. Codex windows are always local (never gated here).
  planWindows?: boolean;
  // Opt-in for /ask: the local claude-CLI-backed metric chat. Default
  // OFF. The `∴ Ask` sidebar entry + the runner are gated on this AND the claude
  // CLI being present AND a non-demo console (all enforced server-side).
  ask?: boolean;
  // Monthly spend budget in USD. The server-visible home for what used
  // to live only in the Spend tab's localStorage, so BOTH the Spend tab AND the
  // Spend tab read the SAME number wherever it is shown.
  // null / absent = no budget set. Local app pref, written like the toggles
  // above via /settings.
  monthlyBudget?: number | null;
  // Noise-gate thresholds. Absent = the gate's own documented defaults
  // (server/noiseGate.ts).
  minorActiveMsThreshold?: number;
  minorMessageCountThreshold?: number;
  [key: string]: unknown;
}

export type ConfigPatch = Partial<ChronicleConfig>;

/** `$CHRONICLE_DATA_DIR`, else `~/.chronicle`. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.CHRONICLE_DATA_DIR?.trim();
  return raw ? raw : join(homedir(), '.chronicle');
}

/** The data folder this process reads and writes, frozen at import. */
export const dataDir: string = resolveDataDir();

const CONFIG_PATH = join(dataDir, 'config.json');

/** The config as it stands. An absent or unparseable file reads as `{}`, so
 * every caller's `?? default` is what decides a missing key. */
export function readConfig(): ChronicleConfig {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

/** Merge `patch` over the current config, write it, and hand back the result. */
export function writeConfig(patch: ConfigPatch): ChronicleConfig {
  const cfg = { ...readConfig(), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}
