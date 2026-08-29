// server/routing.ts (CHI-324 2e) — the roster for routing-compliance, read from
// the hub's governance/model-routing.md `## Roster` table (ported from Varde
// roster.ts + md-table.ts). Ships only the roster MODEL FAMILIES (the curated
// list); the client classifies the window's models on/off-roster and prices the
// off-roster spend from /api/insights. Hub-conditional like Modules/Records:
// live → the real file; demo → a synthetic roster; absent → not present.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveHub } from './hub/resolve.ts';

export interface RosterResult {
  present: boolean;
  /** Curated roster model families (the Model column), e.g. `claude-opus`,
   * `gpt-5.6-terra`. A window model is on-roster if a family is its prefix. */
  families: string[];
}

// A minimal parse of a `## <heading>` markdown table's first column (the port of
// Varde's parseMdTableSection, first-column only — the roster Model names).
function firstColumn(md: string, heading: string): string[] {
  const section = md.match(new RegExp(`## ${heading}[\\s\\S]*?(?=\\n## |$)`));
  if (!section) return [];
  const lines = section[0].split('\n').filter((l) => l.trim().startsWith('|'));
  return lines.slice(2) // skip header + separator rows
    .map((l) => l.split('|').slice(1, -1)[0]?.trim() ?? '')
    .filter((v) => v && !/^-+$/.test(v));
}

const DEMO_FAMILIES = ['claude-opus', 'claude-sonnet', 'claude-haiku', 'claude-fable', 'gpt-5.6-terra', 'glm-5.2', 'kimi-k3'];

export function computeRoster(): RosterResult {
  const h = resolveHub();
  if (h.mode === 'demo') return { present: true, families: DEMO_FAMILIES };
  if (h.mode !== 'live' || !h.root) return { present: false, families: [] };
  try {
    const md = readFileSync(join(h.root, 'governance', 'model-routing.md'), 'utf8');
    const families = firstColumn(md, 'Roster');
    return { present: families.length > 0, families };
  } catch {
    return { present: false, families: [] };
  }
}
