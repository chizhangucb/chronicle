// Client-side memory-graph types (CHI-323 3e). Mirror the server slice shapes
// (server/hub/slices/memorygraph MemGraphNode/MemGraphLink + memoryscope
// ScopeEcho). The client project cannot import server/*, so these are declared
// here and kept in sync by the /api/hub/memory contract.

export type MemoryTier = 'living' | 'historical' | 'excluded';

export interface MemoryNode {
  id: string;
  name: string;
  kind: string;
  tier: MemoryTier;
  val: number;
  color: string;
  path?: string;
  mtime?: string;
  // Runtime fields the force simulation writes onto the node in place.
  x?: number;
  y?: number;
  z?: number;
  [key: string]: unknown;
}

export interface MemoryLink {
  source: string | MemoryNode;
  target: string | MemoryNode;
  kind: 'cross' | 'decision' | 'session';
}

export interface MemoryScopeEcho {
  source: 'defaults' | 'config';
  configured: boolean;
  tiers: { living: string[]; historical: string[]; excluded: string[] };
  rotDays: number;
  rotDaysByKind: Record<string, number>;
  dirs: { dir: string; tier: string; notes: number }[];
}

// Memory analytics reads (CHI-385 parity). These mirror the server slice's
// rot/growth/usage/connectivity shapes (server/hub/slices/memoryscope Rot/
// Growth/Usage/ConnectivityRead). They already ship on /api/hub/memory; the
// client cannot import server/*, so they are declared here and kept in sync by
// the contract. Every field is optional: an older projection may omit any read.

export interface MemoryRot {
  thresholdDays?: number;
  thresholdsByKind?: Record<string, number>;
  buckets?: { label: string; fromDays?: number; toDays?: number | null; count: number }[];
  oldest?: { name?: string; path?: string; kind?: string; ageDays?: number }[];
  oldCount?: number;
  /** Compound rot: old AND unused AND unlinked. */
  flagged?: { name?: string; path?: string; kind?: string; ageDays?: number }[];
  measured?: number;
}

export interface MemoryGrowth {
  /** Daily living-base points (trailing 180d), oldest first. */
  series?: { day: string; total: number; births: number }[];
  birthsByWindow?: Record<string, number>;
  /** Null until two aggregate runs exist to diff (the UI says so). */
  deletions?: { total: number; since: string } | null;
}

export interface MemoryUsageNote {
  note?: string;
  name?: string;
  path?: string;
  kind?: string;
  tier?: string;
  transcript?: number;
  wikilink?: number;
  briefing?: number;
  total?: number;
  days?: { day: string; transcript?: number; wikilink?: number; briefing?: number }[];
}

export interface MemoryUsage {
  totals?: { transcript?: number; wikilink?: number; briefing?: number };
  perNote?: MemoryUsageNote[];
}

export interface MemoryConnectivity {
  /**
   * LIVING notes with zero links in and out, a neutral structural count
   * (orphan v2); records are excluded. The UI derives ORPHANS as the subset
   * with zero touches in the selected window.
   */
  unlinked?: { count?: number; list?: { name?: string; kind?: string; path?: string }[] };
  mostConnected?: { name?: string; links?: number; path?: string }[];
  deadLinks?: { count?: number; list?: { source?: string; sourcePath?: string; target?: string }[] };
  /** Link-degree movement from accrued snapshots; absent until history exists. */
  degreeDeltas?: {
    accruesFrom?: string;
    byPath?: Record<string, { d7?: number | null; d30?: number | null; d90?: number | null }>;
  };
}

/** A living-note timestamp row (the base for windowed views). */
export interface MemoryNoteDate {
  name?: string;
  path?: string;
  kind?: string;
  mtime?: string;
}
