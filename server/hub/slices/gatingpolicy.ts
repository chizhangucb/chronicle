import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Gating-policy slice (CHI-379): a read-only, DESCRIPTIVE view of the machine
 * push posture (scripts/gating_policy.json push_pins + push_pin_defaults), so
 * the Safety page can show what auto-pushes without interpreting or grading it.
 *
 * Same emit-ALLOWLIST discipline as safetynet.ts: only the fields named here
 * ever leave this reader. `scrub_whitelist` entries are REGEXES OVER CHI'S
 * IDENTITY (account handle, name, framework references) — never emitted, a
 * count only, same posture as safetynet's confidential-marker counts.
 * `remote_urls` are public GitHub URLs and are fine to pass through.
 */

export interface PushPinView {
  repo: string;
  visibility: 'public' | 'private' | null;
  remoteUrls: string[];
  branches: string[];
  anyBranch: boolean;
  confidentialOk: boolean;
  featurePushOk: boolean;
  prProtectedBranches: string[];
  leakScrub: boolean;
  scrubWhitelistCount: number;
}

export interface PushPinDefaultsView {
  ownerUrlPattern: string;
  visibility: 'public' | 'private' | null;
  branches: string[];
  featurePushOk: boolean;
  prProtectedBranches: string[];
  leakScrub: boolean;
  scrubWhitelistCount: number;
}

export interface GatingPolicySlice {
  found: boolean;
  pushPins: PushPinView[];
  pushPinDefaults: PushPinDefaultsView | null;
}

function readJson(hubRoot: string, filename: string): unknown {
  try {
    return JSON.parse(readFileSync(join(hubRoot, filename), 'utf8'));
  } catch {
    return null;
  }
}

const VISIBILITIES = new Set(['public', 'private']);
function visibilityOf(v: unknown): 'public' | 'private' | null {
  return typeof v === 'string' && VISIBILITIES.has(v) ? (v as 'public' | 'private') : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
function bool(v: unknown): boolean {
  return v === true;
}

/** push_pins -> per-repo pin, emit-allowlisted. scrub_whitelist is COUNTED, never
 * its regex values (they are identity markers). */
function projectPushPins(raw: unknown): PushPinView[] {
  if (raw === null || typeof raw !== 'object') return [];
  const out: PushPinView[] = [];
  for (const [repo, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (repo.startsWith('_') || spec === null || typeof spec !== 'object') continue;
    const o = spec as Record<string, unknown>;
    out.push({
      repo,
      visibility: visibilityOf(o.visibility),
      remoteUrls: strArray(o.remote_urls),
      branches: strArray(o.branches),
      anyBranch: bool(o.any_branch),
      confidentialOk: bool(o.confidential_ok),
      featurePushOk: bool(o.feature_push_ok),
      prProtectedBranches: strArray(o.pr_protected_branches),
      leakScrub: bool(o.leak_scrub),
      scrubWhitelistCount: strArray(o.scrub_whitelist).length,
    });
  }
  return out;
}

/** push_pin_defaults -> the owner rule, emit-allowlisted the same way. */
function projectPushPinDefaults(raw: unknown): PushPinDefaultsView | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const pattern = typeof o.owner_url_pattern === 'string' ? o.owner_url_pattern : '';
  const d = o.defaults && typeof o.defaults === 'object' ? (o.defaults as Record<string, unknown>) : {};
  return {
    ownerUrlPattern: pattern,
    visibility: visibilityOf(d.visibility),
    branches: strArray(d.branches),
    featurePushOk: bool(d.feature_push_ok),
    prProtectedBranches: strArray(d.pr_protected_branches),
    leakScrub: bool(d.leak_scrub),
    scrubWhitelistCount: strArray(d.scrub_whitelist).length,
  };
}

/** Reads scripts/gating_policy.json at hubRoot and projects push_pins +
 * push_pin_defaults through their emit-allowlists. A missing file yields an
 * empty (found:false) slice. Never opens `egress`, `self_close`, `github`, or
 * any other top-level key — this slice is push-posture only. */
export function collectGatingPolicy(hubRoot: string): GatingPolicySlice {
  const raw = readJson(hubRoot, 'scripts/gating_policy.json');
  if (raw === null || typeof raw !== 'object') {
    return { found: false, pushPins: [], pushPinDefaults: null };
  }
  const o = raw as Record<string, unknown>;
  return {
    found: true,
    pushPins: projectPushPins(o.push_pins),
    pushPinDefaults: projectPushPinDefaults(o.push_pin_defaults),
  };
}
