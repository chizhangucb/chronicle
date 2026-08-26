import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Confidential marker drill-down (ported from Varde, hard-gated per D8). This is
 * the ONE reader that does the opposite of the confidentiality floor: it keeps
 * the raw confidential marker PHRASES (the words the gate's scanner watches for
 * — a project codename, an unreleased deal term, and the like), which the public
 * safetynet slice reduces to counts. So its endpoint is hard-gated: a config flag defaulting
 * OFF, AND a real (non-demo) live hub. The default/public build never serves it;
 * a release-walk pin asserts that. Gate-not-drop keeps the opted-in operator's
 * Safety drill-down without ever exposing it to a stranger.
 */
export interface ConfidentialMarkerCategory {
  category: string;
  phrases: string[];
}

/** Reads confidential_markers.json with phrases INTACT. Same source file the
 * safetynet slice summarizes to counts; only this gated path keeps the words. */
export function readConfidentialMarkers(hubRoot: string): { categories: ConfidentialMarkerCategory[] } {
  try {
    const raw = JSON.parse(
      readFileSync(join(hubRoot, 'scripts', 'egress_gate', 'data', 'confidential_markers.json'), 'utf8'),
    ) as Record<string, unknown>;
    const categories: ConfidentialMarkerCategory[] = [];
    for (const [category, value] of Object.entries(raw)) {
      if (category.startsWith('_') || !Array.isArray(value)) continue;
      categories.push({ category, phrases: value.filter((v): v is string => typeof v === 'string') });
    }
    return { categories };
  } catch {
    return { categories: [] };
  }
}

/** Whether the confidential drill-down may be served. Hard gate (D8):
 * (a) an explicit opt-in flag (CHRONICLE_CONFIDENTIAL_MARKERS=1 or config
 *     confidentialMarkers:true) defaulting OFF, AND
 * (b) a real live hub (never demo, never absent).
 * The default build returns false, so no confidential content leaves any
 * endpoint. */
export function confidentialMarkersEnabled(
  mode: 'live' | 'demo' | 'absent',
  env: Record<string, string | undefined>,
  configFlag: boolean | undefined,
): boolean {
  if (mode !== 'live') return false;
  return env.CHRONICLE_CONFIDENTIAL_MARKERS === '1' || configFlag === true;
}
