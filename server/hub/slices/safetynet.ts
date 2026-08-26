import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Safety-net slice: a read-only, DESCRIPTIVE view of the egress gate's own
 * config (scripts/egress_gate/data/*.json), so the Safety page can show what the
 * gate would enforce without interpreting or grading it.
 *
 * Ported from Varde with review #9's hardening for a PUBLIC product: instead of
 * a secret-key DENYLIST (which lets a creds value under an innocuous key slip
 * through), each file is projected through an emit-ALLOWLIST — only the exact
 * fields named here ever leave this reader — and every emitted string still
 * passes a value-side creds scan. Marker phrases are reduced to per-category
 * COUNTS (the phrases themselves are confidential; the drill-down is a
 * hard-gated separate endpoint, D8).
 */

export interface MarkerCategoryCount { category: string; count: number }

export interface GateConfigView {
  enabled: boolean;
  spend_per_tx_cap: number | null;
  spend_per_session_cap: number | null;
  unclassified_deny_daily_cap: number | null;
}

export interface ClassificationView {
  tools: { name: string; class: string }[];
}

export interface SafetyNetSlice {
  found: boolean;
  gateConfig: GateConfigView | null;
  classification: ClassificationView | null;
  markers: { categories: MarkerCategoryCount[] };
  proxyServers: { names: string[] } | null;
}

// A value that looks like a credential never leaves this reader, even from an
// allowlisted field (defense in depth on top of the allowlist). Catches long
// hex/base64 tokens, sk-/pk- keys, bearer strings, and URLs with embedded creds.
const CREDS_VALUE = /\b(sk|pk|rk)[-_][A-Za-z0-9]{12,}|bearer\s+[A-Za-z0-9._-]{12,}|[A-Za-z0-9+/]{40,}={0,2}|:\/\/[^/\s:@]+:[^/\s@]+@/i;
function scrubString(v: unknown): string {
  const s = String(v);
  return CREDS_VALUE.test(s) ? '[redacted]' : s;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readJson(dataDir: string, filename: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dataDir, filename), 'utf8'));
  } catch {
    return null;
  }
}

/** gate_config.json -> only the four managed knobs, nothing else. */
function projectGateConfig(raw: unknown): GateConfigView | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled !== false,
    spend_per_tx_cap: numOrNull(o.spend_per_tx_cap),
    spend_per_session_cap: numOrNull(o.spend_per_session_cap),
    unclassified_deny_daily_cap: numOrNull(o.unclassified_deny_daily_cap),
  };
}

/** classification.json -> {name, class} per tool ONLY; any other per-tool field
 * (and any tool whose class is not a known bucket) is dropped. */
function projectClassification(raw: unknown): ClassificationView | null {
  if (raw === null || typeof raw !== 'object') return null;
  const tools = (raw as Record<string, unknown>).tools;
  if (tools === null || typeof tools !== 'object') return { tools: [] };
  const out: { name: string; class: string }[] = [];
  for (const [name, spec] of Object.entries(tools as Record<string, unknown>)) {
    const klass = spec && typeof spec === 'object' ? (spec as Record<string, unknown>).class : undefined;
    if (typeof klass === 'string' && ['read', 'send', 'publish', 'spend'].includes(klass)) {
      out.push({ name: scrubString(name), class: klass });
    }
  }
  return { tools: out };
}

/** confidential_markers.json -> per-category COUNTS only (never the phrases). */
function summarizeMarkers(raw: unknown): { categories: MarkerCategoryCount[] } {
  if (raw === null || typeof raw !== 'object') return { categories: [] };
  const categories: MarkerCategoryCount[] = [];
  for (const [category, value] of Object.entries(raw as Record<string, unknown>)) {
    if (category.startsWith('_')) continue;
    if (Array.isArray(value)) categories.push({ category, count: value.length });
  }
  return { categories };
}

/** proxy_servers.json -> the list of proxy NAMES (top-level keys) only, scrubbed.
 * Never the hosts/urls/credentials a proxy entry may carry. */
function projectProxyServers(raw: unknown): { names: string[] } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const src = Array.isArray(raw) ? raw : Object.keys(raw as Record<string, unknown>);
  const names = (Array.isArray(raw) ? (raw as unknown[]).map((v) => (v && typeof v === 'object' ? String((v as Record<string, unknown>).name ?? '') : String(v))) : (src as string[]))
    .filter((n) => n && !n.startsWith('_'))
    .map(scrubString);
  return { names };
}

/** Reads the four egress-gate data files under hubRoot and projects each through
 * its emit-allowlist. A missing data dir yields an empty (found:false) slice. */
export function collectSafetyNet(hubRoot: string): SafetyNetSlice {
  const dataDir = join(hubRoot, 'scripts', 'egress_gate', 'data');
  const gateConfigRaw = readJson(dataDir, 'gate_config.json');
  const classificationRaw = readJson(dataDir, 'classification.json');
  const markersRaw = readJson(dataDir, 'confidential_markers.json');
  const proxyRaw = readJson(dataDir, 'proxy_servers.json');
  const found = gateConfigRaw !== null || classificationRaw !== null || markersRaw !== null;
  return {
    found,
    gateConfig: projectGateConfig(gateConfigRaw),
    classification: projectClassification(classificationRaw),
    markers: summarizeMarkers(markersRaw),
    proxyServers: projectProxyServers(proxyRaw),
  };
}
