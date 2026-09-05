// The nisse-hub adapter: one typed read seam per hub slice (CHI-323 part 1.3).
//
// DELIBERATE shape difference from Varde: Chronicle does NOT port Varde's
// monolithic `LiveData` blob or its `aggregate()` batch. Chronicle serves per
// request, so each slice is its own typed method with its own endpoint and its
// own file-state freshness (freshness.ts). The surface contract pins each slice
// independently and phases 2-3 compose without a giant shared object.
//
// Slice methods are added to `HubAdapter` as their organ lands. Phase 1a
// establishes the
// interface + `status()` + the three implementations + the factory, so every
// organ just plugs a method into Live/Demo and the route wiring already exists.
import { resolveHub, type HubMode, type HubHandle } from './resolve.ts';
import { collectSafetyNet, type SafetyNetSlice } from './slices/safetynet.ts';
import { collectEgress, type EgressSlice } from './slices/egress.ts';
import { collectSafetyGaps, type SafetyGapsSlice } from './slices/gaps.ts';
import { collectGatingPolicy, type GatingPolicySlice } from './slices/gatingpolicy.ts';
import { readConfidentialMarkers, type ConfidentialMarkerCategory } from './slices/confidential.ts';
import { collectCodegraphs, type DashGraphEntry } from './slices/codegraph.ts';
import { loadConfidentialSegments, ConfidentialPolicyUnavailable } from './confidential-segments.ts';
import { freshSliceAsync, treeMaxMtimeMs } from './freshness.ts';
import { join } from 'node:path';
import { safetyGapsRegisterPath } from './paths.ts';
import { DEMO_SAFETYNET, DEMO_EGRESS, DEMO_GATINGPOLICY, demoCodegraphs } from './demo.ts';

// The HEAVY slice re-checks freshness at most this often (a stat-walk over
// every built graph is not free); inside the window the cached value is served
// without touching the filesystem.
const HEAVY_TTL_MS = 30_000;

export type { HubMode, HubHandle } from './resolve.ts';

export interface HubStatus {
  present: boolean;
  mode: HubMode;
  root: string | null;
  reason?: string;
}

export interface HubAdapter {
  /** Cheap, always available. The client gates all ops nav on this. */
  status(): HubStatus;
  /** Egress-gate posture, emit-allowlisted, markers as counts (organ 1d). */
  safetyNet(): SafetyNetSlice;
  /** Egress kill-switch on/off (organ 1d). */
  egress(): EgressSlice;
  /** Accepted-gaps register + live posture (organ 1d). */
  safetyGaps(): SafetyGapsSlice;
  /** Push posture: per-repo conditioned-auto pins + the owner-rule defaults
   * (CHI-379), emit-allowlisted (scrub_whitelist counted, never emitted). */
  gatingPolicy(): GatingPolicySlice;
  /** Raw confidential marker phrases (organ 1d) — HARD-GATED at the route (D8);
   * the adapter only reads, the route decides whether it may be served. */
  confidentialMarkers(): { categories: ConfidentialMarkerCategory[] };
  /** Built code graphs (graphs/index.json + per-graph god-nodes) (organ 1g).
   * HEAVY: freshness-cached. */
  codegraphs(): Promise<DashGraphEntry[]>;
}

/** Live hub: reads a real nisse-format hub at `root`. */
export class LiveHubAdapter implements HubAdapter {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  status(): HubStatus {
    return { present: true, mode: 'live', root: this.root };
  }
  safetyNet(): SafetyNetSlice {
    return collectSafetyNet(this.root);
  }
  egress(): EgressSlice {
    return collectEgress(this.root);
  }
  safetyGaps(): SafetyGapsSlice {
    return collectSafetyGaps(safetyGapsRegisterPath(), this.safetyNet(), this.egress().enabled);
  }
  gatingPolicy(): GatingPolicySlice {
    return collectGatingPolicy(this.root);
  }
  confidentialMarkers(): { categories: ConfidentialMarkerCategory[] } {
    return readConfidentialMarkers(this.root);
  }
  codegraphs(): Promise<DashGraphEntry[]> {
    return freshSliceAsync('codegraphs', () => String(treeMaxMtimeMs(join(this.root, 'graphs'))), () => collectCodegraphs(this.root), { ttlMs: HEAVY_TTL_MS });
  }
}

/** Demo hub (CHRONICLE_DEMO=1): synthetic slices so a zero-data user, or Chi on
 * a fresh machine, sees the full product. Every real-state action fail-closes
 * (409) at the route layer; the adapter only serves synthetic reads. */
export class DemoHubAdapter implements HubAdapter {
  status(): HubStatus {
    return { present: true, mode: 'demo', root: null };
  }
  safetyNet(): SafetyNetSlice {
    return DEMO_SAFETYNET;
  }
  egress(): EgressSlice {
    return DEMO_EGRESS;
  }
  safetyGaps(): SafetyGapsSlice {
    return collectSafetyGaps(safetyGapsRegisterPath(), DEMO_SAFETYNET, DEMO_EGRESS.enabled);
  }
  gatingPolicy(): GatingPolicySlice {
    return DEMO_GATINGPOLICY;
  }
  // Demo NEVER serves confidential phrases; the route also blocks demo (D8).
  confidentialMarkers(): { categories: ConfidentialMarkerCategory[] } {
    return { categories: [] };
  }
  codegraphs(): Promise<DashGraphEntry[]> {
    return Promise.resolve(demoCodegraphs());
  }
}

/** No hub: ops routes hide, the Nisse upsell shows. Slice reads return the
 * absent sentinel at the route layer. */
export class NullHubAdapter implements HubAdapter {
  readonly reason?: string;
  constructor(reason?: string) { this.reason = reason; }
  status(): HubStatus {
    return { present: false, mode: 'absent', root: null, reason: this.reason };
  }
  safetyNet(): SafetyNetSlice {
    return { found: false, gateConfig: null, classification: null, markers: { categories: [] }, proxyServers: null };
  }
  egress(): EgressSlice {
    return { enabled: true, gateConfigFound: false };
  }
  safetyGaps(): SafetyGapsSlice {
    return { header: '', actionable: [], watch: [], posture: { classificationRules: 0, markerCategories: [], spendCaps: {}, egressEnabled: true } };
  }
  gatingPolicy(): GatingPolicySlice {
    return { found: false, pushPins: [], pushPinDefaults: null };
  }
  confidentialMarkers(): { categories: ConfidentialMarkerCategory[] } {
    return { categories: [] };
  }
  codegraphs(): Promise<DashGraphEntry[]> {
    return Promise.resolve([]);
  }
}

/**
 * Resolve the right adapter for the current environment. NOT memoized:
 * resolution is a handful of stat calls, and the setup affordance can flip
 * absent -> live mid-process by writing config.json, so every call re-resolves
 * (matches D1 "read live").
 */
export function getHubAdapter(env: Record<string, string | undefined> = process.env): HubAdapter {
  const h: HubHandle = resolveHub(env);
  if (h.mode === 'demo') return new DemoHubAdapter();
  if (h.mode === 'live') return new LiveHubAdapter(h.root as string);
  return new NullHubAdapter(h.reason);
}
