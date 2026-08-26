// The nisse-hub adapter: one typed read seam per hub slice (CHI-323 part 1.3).
//
// DELIBERATE shape difference from Varde: Chronicle does NOT port Varde's
// monolithic `LiveData` blob or its `aggregate()` batch. Chronicle serves per
// request, so each slice is its own typed method with its own endpoint and its
// own file-state freshness (freshness.ts). The surface contract pins each slice
// independently and phases 2-3 compose without a giant shared object.
//
// Slice methods are added to `HubAdapter` as their organ lands (1c Modules,
// 1d Safety, 1e Jobs, 1f Briefing, 1g Memory). Phase 1a establishes the
// interface + `status()` + the three implementations + the factory, so every
// organ just plugs a method into Live/Demo and the route wiring already exists.
import { resolveHub, type HubMode, type HubHandle } from './resolve.ts';
import { collectModules, type ModulesSlice } from './slices/modules.ts';
import { collectSafetyNet, type SafetyNetSlice } from './slices/safetynet.ts';
import { collectEgress, type EgressSlice } from './slices/egress.ts';
import { collectSafetyGaps, type SafetyGapsSlice } from './slices/gaps.ts';
import { readConfidentialMarkers, type ConfidentialMarkerCategory } from './slices/confidential.ts';
import { collectJobs, type JobsSlice } from './slices/jobs.ts';
import { collectAutomations } from './slices/automations.ts';
import { safetyGapsRegisterPath, packageRoot } from './paths.ts';
import { DEMO_MODULES, DEMO_SAFETYNET, DEMO_EGRESS, DEMO_JOBS } from './demo.ts';

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
  /** Modules registry + snapshotted product contracts (organ 1c). */
  modules(): ModulesSlice;
  /** Egress-gate posture, emit-allowlisted, markers as counts (organ 1d). */
  safetyNet(): SafetyNetSlice;
  /** Egress kill-switch on/off (organ 1d). */
  egress(): EgressSlice;
  /** Accepted-gaps register + live posture (organ 1d). */
  safetyGaps(): SafetyGapsSlice;
  /** Raw confidential marker phrases (organ 1d) — HARD-GATED at the route (D8);
   * the adapter only reads, the route decides whether it may be served. */
  confidentialMarkers(): { categories: ConfidentialMarkerCategory[] };
  /** Scheduled jobs: launchd + cron + hub registry + repo templates (organ 1e). */
  jobs(): JobsSlice;
  // Further per-slice reads land with their organs:
  //   roster(): RosterSlice
  //   memoryGraph(scope): MemorySlice
  //   codegraphs(): CodegraphSlice
}

const EMPTY_JOBS: JobsSlice = { scannedAt: '', sources: { launchd: 0, cron: 0, registry: 0, 'repo-template': 0 }, jobs: [] };

/** Live hub: reads a real nisse-format hub at `root`. */
export class LiveHubAdapter implements HubAdapter {
  readonly root: string;
  constructor(root: string) { this.root = root; }
  status(): HubStatus {
    return { present: true, mode: 'live', root: this.root };
  }
  // Modules is a LIGHT slice: read fresh per request (a handful of file reads),
  // no on-disk cache. The heavy slices (memory, codegraphs) use freshness.ts.
  modules(): ModulesSlice {
    return collectModules(this.root);
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
  confidentialMarkers(): { categories: ConfidentialMarkerCategory[] } {
    return readConfidentialMarkers(this.root);
  }
  // Scans the REAL machine (launchd/cron) enriched by the hub registry +
  // Chronicle's shipped-but-dormant templates. Read-only.
  jobs(): JobsSlice {
    return collectJobs({ registry: collectAutomations(this.root), repoRoot: packageRoot() });
  }
}

/** Demo hub (CHRONICLE_DEMO=1): synthetic slices so a zero-data user, or Chi on
 * a fresh machine, sees the full product. Every real-state action fail-closes
 * (409) at the route layer; the adapter only serves synthetic reads. */
export class DemoHubAdapter implements HubAdapter {
  status(): HubStatus {
    return { present: true, mode: 'demo', root: null };
  }
  modules(): ModulesSlice {
    return DEMO_MODULES;
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
  // Demo NEVER serves confidential phrases; the route also blocks demo (D8).
  confidentialMarkers(): { categories: ConfidentialMarkerCategory[] } {
    return { categories: [] };
  }
  // Synthetic jobs; never scans the real machine.
  jobs(): JobsSlice {
    return DEMO_JOBS;
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
  // Never reached in practice: the route checks status().present first and
  // returns the absent sentinel. Present for interface completeness.
  modules(): ModulesSlice {
    return { found: false, rows: [] };
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
  confidentialMarkers(): { categories: ConfidentialMarkerCategory[] } {
    return { categories: [] };
  }
  jobs(): JobsSlice {
    return EMPTY_JOBS;
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
