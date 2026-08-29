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
import { collectRecords, EMPTY_RECORDS, type RecordsSlice } from './slices/records.ts';
import { collectAutomations } from './slices/automations.ts';
import { collectMemoryGraph, type MemorySlice } from './slices/memorygraph.ts';
import { loadMemoryConfig, memoryScopeConfigPath } from './slices/memoryscope.ts';
import { collectHubFileTouches, hubTouchSignature } from './slices/fileTouches.ts';
import { collectCodegraphs, type DashGraphEntry } from './slices/codegraph.ts';
import { freshSliceAsync, treeMaxMtimeMs, pathsMaxMtimeMs } from './freshness.ts';
import { dataDir } from '../db.ts';
import { join } from 'node:path';
import { safetyGapsRegisterPath, packageRoot } from './paths.ts';
import { DEMO_MODULES, DEMO_SAFETYNET, DEMO_EGRESS, DEMO_JOBS, DEMO_RECORDS, demoMemory, demoCodegraphs, EMPTY_MEMORY } from './demo.ts';

// The two HEAVY slices re-check freshness at most this often (a stat-walk over
// the whole hub markdown corpus / every built graph is not free); inside the
// window the cached value is served without touching the filesystem.
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
  /** Append-only hub records (CHI-324): decisions + session ledger, index
   * fields only (never the decision body). LIGHT slice, read fresh. */
  records(): RecordsSlice;
  /** Memory graph over the hub markdown corpus, titles/paths only (organ 1g).
   * HEAVY: freshness-cached. */
  memoryGraph(): Promise<MemorySlice>;
  /** Built code graphs (graphs/index.json + per-graph god-nodes) (organ 1g).
   * HEAVY: freshness-cached. */
  codegraphs(): Promise<DashGraphEntry[]>;
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
  // Records is a LIGHT slice: two small JSONL reads, read fresh per request.
  records(): RecordsSlice {
    return collectRecords(this.root);
  }
  memoryGraph(): Promise<MemorySlice> {
    // Sig folds in the memory-scope config file's mtime (CHI-339), not just the
    // hub's .md tree: without it, a confirmed scope edit would never invalidate
    // this heavy slice's cache (the config lives under ${HOME}, outside the hub).
    const hubRoot = this.root;
    return freshSliceAsync(
      'memory',
      // Fold in a cheap session signature so the Usage lane's transcript touches
      // (CHI-385) refresh after new sessions import, not only when the .md tree
      // or scope config change.
      () => `${treeMaxMtimeMs(this.root, (n) => n.endsWith('.md'))}:${pathsMaxMtimeMs([memoryScopeConfigPath()])}:${hubTouchSignature()}`,
      () => {
        const { config, source } = loadMemoryConfig();
        return collectMemoryGraph(this.root, {
          config,
          configSource: source,
          // Usage channel a: hub-file reads/edits from this machine's sessions.
          fileTouches: collectHubFileTouches(hubRoot),
          // Cross-run accrual (deletions + link-degree deltas). The collector
          // writes these under the data dir and diffs against the last run;
          // both read empty on the first scan and say so, honestly.
          snapshotPath: join(dataDir, 'memory-scope-snapshot.json'),
          degreeHistoryPath: join(dataDir, 'memory-degree-history.json'),
        });
      },
      { ttlMs: HEAVY_TTL_MS },
    );
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
  records(): RecordsSlice {
    return DEMO_RECORDS;
  }
  memoryGraph(): Promise<MemorySlice> {
    return Promise.resolve(demoMemory());
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
  records(): RecordsSlice {
    return EMPTY_RECORDS;
  }
  memoryGraph(): Promise<MemorySlice> {
    return Promise.resolve(EMPTY_MEMORY);
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
