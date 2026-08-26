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
import { DEMO_MODULES } from './demo.ts';

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
  // Further per-slice reads land with their organs:
  //   jobs(): JobsSlice
  //   roster(): RosterSlice
  //   memoryGraph(scope): MemorySlice
  //   safetyNet(): SafetyNetSlice
  //   egress(): EgressSlice
  //   codegraphs(): CodegraphSlice
}

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
