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
