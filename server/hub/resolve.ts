// Nisse-hub resolution + detection + mode (CHI-323 part 1.2).
//
// Nisse is the OSS skeleton of the AIOS hub: a directory carrying the taxonomy
// operations.md + records/ + governance/ (+ context/, wiki/, graphs/). The
// adapter reads the FORMAT, not any one instance, so public Chronicle degrades
// cleanly for a stranger with no hub and lights up for anyone running nisse.
//
// This is the ONLY thing that couples Chronicle to a hub repo; it is the single
// seam phases 2-3 extend, so it stays absent-graceful and dependency-light.
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readConfig } from '../autosync.ts';

export type HubMode = 'live' | 'demo' | 'absent';
export interface HubHandle {
  mode: HubMode;
  root: string | null;
  reason?: string;
}

/** Expand a leading `~` / `~/` to the user's home dir; otherwise return as-is. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * A path is a nisse-format hub when it carries the taxonomy floor:
 * operations.md (file) AND records/ (dir) AND governance/ (dir). A path that
 * fails this probe is treated as absent, never a half-wired hub.
 */
export function isNisseHub(root: string): boolean {
  try {
    return (
      statSync(join(root, 'operations.md')).isFile() &&
      statSync(join(root, 'records')).isDirectory() &&
      statSync(join(root, 'governance')).isDirectory()
    );
  } catch {
    return false;
  }
}

/** hubRoot from ~/.chronicle/config.json, read via autosync's readConfig so we
 * share the exact file + parse (never a second config file). */
function hubRootFromConfig(): string | undefined {
  const v = readConfig().hubRoot;
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * Resolution order (D3, DECIDED). No personal hub path is baked into shipped
 * code: an author's own instance resolves via config.json hubRoot (written by
 * the one-time setup affordance) exactly like a stranger's would.
 *
 *   1. CHRONICLE_DEMO=1        -> demo   (synthetic slices, panels visible)
 *   2. CHRONICLE_HUB env       -> live   (primary public knob; mirrors Varde AIOS_HUB)
 *   3. AIOS_HUB env            -> live
 *   4. config.json hubRoot     -> live   (how Chi's instance resolves)
 *   5. else                    -> absent (with a reason)
 *
 * A candidate that is set but not nisse-shaped does not resolve; its reason is
 * collected and surfaced when nothing resolves (so a typo'd path is legible,
 * not silently swallowed).
 */
export function resolveHub(env: Record<string, string | undefined> = process.env): HubHandle {
  if (env.CHRONICLE_DEMO === '1') return { mode: 'demo', root: null };

  const candidates: [string, string | undefined][] = [
    ['CHRONICLE_HUB', env.CHRONICLE_HUB],
    ['AIOS_HUB', env.AIOS_HUB],
    ['config.json hubRoot', hubRootFromConfig()],
  ];

  const reasons: string[] = [];
  for (const [label, raw] of candidates) {
    if (!raw || !raw.trim()) continue;
    const root = resolve(expandTilde(raw.trim()));
    if (isNisseHub(root)) return { mode: 'live', root };
    reasons.push(`${label} (${raw}) is not a nisse-format hub — need operations.md + records/ + governance/`);
  }

  const reason = reasons.length
    ? reasons.join('; ')
    : 'no hub configured — set CHRONICLE_HUB, or run `chronicle hub set <path>`';
  return { mode: 'absent', root: null, reason };
}
