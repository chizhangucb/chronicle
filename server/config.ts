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
// Two ways to ask for the folder, and the difference matters. `dataDir` is
// frozen at import, because it is what an entry point opens the database against
// (server/db.ts's openDatabase() defaults to it): a later change to
// $CHRONICLE_DATA_DIR would move the config without moving the already-open
// database. `resolveDataDir(env)` is the same rule as a pure function, for the
// callers that are handed an environment rather than reading the process's own:
// the Ask history path, which takes one so a test can point it somewhere else.
import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Everything the operator can set in `config.json`. */
export interface ChronicleConfig {
  autoSync?: boolean;
  autoSyncPaused?: boolean;
  // Spend-tab Claude Plan windows, default ON (opt-OUT). The
  // ONE outbound call in Chronicle: reads the operator's own Claude quota from
  // api.anthropic.com (the token's own issuer, like Claude Code). Set false for a
  // fully offline instance. Codex windows are always local (never gated here).
  planWindows?: boolean;
  // Opt-in for /ask: the local claude-CLI-backed metric chat. Default
  // OFF. The `∴ Ask` sidebar entry + the runner are gated on this AND the claude
  // CLI being present AND a non-demo app (all enforced server-side).
  ask?: boolean;
  // Monthly spend budget in USD. The server-visible home for what used
  // to live only in the Spend tab's localStorage, so every surface that shows
  // the budget reads the SAME number.
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

/** The config as it stands. An absent, unparseable, or non-object file reads as
 * `{}`, so every caller's `?? default` is what decides a missing key. The
 * non-object check is not paranoia: a `config.json` holding `null` parses
 * without throwing, and every `readConfig().key` on the insert path (the noise
 * gate) and in /settings would then throw on a null dereference. */
export function readConfig(): ChronicleConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ChronicleConfig;
  } catch { return {}; }
}

/** Merge `patch` over the current config, write it, and hand back the result. */
export function writeConfig(patch: ConfigPatch): ChronicleConfig {
  const cfg = { ...readConfig(), ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}
