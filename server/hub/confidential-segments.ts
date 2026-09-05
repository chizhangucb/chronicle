// Confidential-segment prune set, read from the connected hub at RUNTIME (CHI-390).
//
// Why this exists: Chronicle walks the operator's real hub filesystem to build
// the freshness / modules views. To never surface a confidential tree
// it must prune those trees from the walk. The naive way (hardcoding the tree
// NAMES in this committed, PUBLIC source) publishes the very names it guards: a
// hardcoded prune list would leak the confidential tree names it exists to hide.
//
// Instead the HUB owns the list: it declares its confidential segments privately
// in scripts/egress_gate/data/confidential_segments.json, and this module reads
// them at runtime. Public Chronicle source names only the generic `confidential`
// floor (which reveals nothing). The specific names live only in the private hub.
//
// FAIL CLOSED: this is called only with a resolved LIVE hub root (isNisseHub
// true, see resolve.ts). On such a hub a missing / malformed / empty declaration
// is an ERROR, never a "walk everything" default: it throws
// ConfidentialPolicyUnavailable and the hub slices degrade to an empty
// projection rather than walk the hub unpruned. A stranger's or the OSS hub
// ships its own confidential_segments.json so its path stays lit; the demo /
// no-hub adapters never call this (they serve synthetic / empty slices).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A directory literally named `confidential` is confidential on any hub. Safe
 * to hardcode in public source (it reveals nothing). The SPECIFIC tree names are
 * never hardcoded here; they come from the hub's private declaration. */
const GENERIC_FLOOR: readonly string[] = ['confidential'];

/** The hub's private declaration, relative to the hub root. */
const DECLARATION_REL = join('scripts', 'egress_gate', 'data', 'confidential_segments.json');

/** Thrown when a live hub cannot produce a valid confidential-segment
 * declaration. Callers MUST catch this and fail closed (empty projection),
 * never fall back to walking the hub with a partial prune set. */
export class ConfidentialPolicyUnavailable extends Error {
  constructor(detail: string) {
    super(`confidential policy unavailable: ${detail}`);
    this.name = 'ConfidentialPolicyUnavailable';
  }
}

/**
 * The set of hub directory-segment names a public projection must never descend
 * into: the generic `confidential` floor UNION the hub's privately-declared
 * specific confidential trees. Matches Chronicle's existing prune semantics (a
 * path is confidential when ANY of its segments is in this set), so a broadened
 * user scope config still cannot surface a confidential tree.
 *
 * @param hubRoot a resolved LIVE hub root (isNisseHub already true).
 * @throws ConfidentialPolicyUnavailable if the declaration is missing, malformed,
 *   the wrong shape, or an empty list. Callers fail closed on this.
 */
export function loadConfidentialSegments(hubRoot: string): Set<string> {
  const file = join(hubRoot, DECLARATION_REL);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ConfidentialPolicyUnavailable(`cannot read ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfidentialPolicyUnavailable(`${file} is not valid JSON`);
  }
  const segs = (parsed as { confidential_segments?: unknown } | null)?.confidential_segments;
  if (!Array.isArray(segs) || segs.length === 0
      || !segs.every((s) => typeof s === 'string' && s.length > 0)) {
    throw new ConfidentialPolicyUnavailable(
      `${file} has no valid non-empty confidential_segments array`);
  }
  return new Set<string>([...GENERIC_FLOOR, ...(segs as string[])]);
}

/** The absolute path to a hub's confidential-segment declaration. Exported so a
 * caller can fold its mtime into a freshness signature: tightening the policy
 * then invalidates a cached projection instead of waiting on the TTL (CHI-390
 * review). */
export function confidentialSegmentsPath(hubRoot: string): string {
  return join(hubRoot, DECLARATION_REL);
}
