import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expandTilde } from '../resolve.ts';
import { parseMdTableSectionWithHeader } from './md-table.ts';

/**
 * Modules slice (ported from Varde, CHI-323 3a): the module product-contract
 * practice registers one row per module in the hub's `## Modules` table
 * (operations.md) plus a `product-contract.md` per module. This reader parses
 * the table and snapshots each RESOLVABLE contract's markdown, read-only. It
 * refuses any path that is not named `product-contract.md` or that passes
 * through a confidential segment (the set loaded from the hub at runtime),
 * however a registry cell got it there (confidentiality floor, part 1.6).
 * Light: read fresh per request.
 */

export type ModuleContractStatus = 'full' | 'pending' | 'grandfathered';

export interface ModuleContract {
  status: ModuleContractStatus;
  /** Cell text as written in the registry (path, or "(pending CHI-NNN)"). */
  raw: string;
  /** Ticket id when status is "pending"; null otherwise. */
  pendingTicket: string | null;
  /** Resolved absolute path this reader attempted; null for pending/blank cells. */
  path: string | null;
  /** True iff the contract markdown was actually read. */
  available: boolean;
  /** Full contract text, snapshotted here; null when pending or unreadable. */
  markdown: string | null;
}

export interface ModuleRow {
  name: string;
  tier: string;
  purpose: string;
  prdHome: string;
  project: string;
  contract: ModuleContract;
}

export interface ModulesSlice {
  found: boolean;
  rows: ModuleRow[];
}

// The same hard prune the whole-hub walk applies: never read anything whose
// resolved path passes through one of the confidential segments (loaded from the
// hub at runtime, CHI-390, and passed in), however a registry cell got it there.
// Checked on every resolved path, not just paths under hubRoot.
function pathIsConfidential(resolvedPath: string, segments: Set<string>): boolean {
  return resolvedPath.split(/[\\/]+/).some((segment) => segments.has(segment));
}

/**
 * Resolves a registry contract cell into a ModuleContract. Never throws: an
 * unreadable, disallowed, or malformed path degrades to
 * `available: false, markdown: null` rather than failing the slice.
 */
export function parseContractCell(cell: string, hubRoot: string, confidentialSegments: Set<string>): ModuleContract {
  const trimmed = cell.trim();

  const pendingMatch = trimmed.match(/^\(pending\s+([A-Z]+-\d+)\)$/i);
  if (pendingMatch) {
    return { status: 'pending', raw: trimmed, pendingTicket: pendingMatch[1], path: null, available: false, markdown: null };
  }

  const grandfathered = trimmed.startsWith('†'); // dagger
  const rawPath = grandfathered ? trimmed.slice(1).trim() : trimmed;
  const status: ModuleContractStatus = grandfathered ? 'grandfathered' : 'full';

  if (!rawPath) {
    return { status, raw: trimmed, pendingTicket: null, path: null, available: false, markdown: null };
  }

  const expanded = expandTilde(rawPath);
  const resolved = expanded.startsWith('/') ? expanded : join(hubRoot, expanded);

  // Contracts are read by the module practice's naming convention only; anything
  // else -- however a cell got written -- is refused.
  if (basename(resolved) !== 'product-contract.md' || pathIsConfidential(resolved, confidentialSegments)) {
    console.warn(`[modules] refusing to read contract path outside convention/policy: ${resolved}`);
    return { status, raw: rawPath, pendingTicket: null, path: resolved, available: false, markdown: null };
  }

  try {
    const markdown = readFileSync(resolved, 'utf8');
    return { status, raw: rawPath, pendingTicket: null, path: resolved, available: true, markdown };
  } catch {
    return { status, raw: rawPath, pendingTicket: null, path: resolved, available: false, markdown: null };
  }
}

/**
 * Finds the `## Modules` section and maps its table into ModuleRow entries,
 * reading columns by header NAME so column order in operations.md can move
 * without breaking this. Rows missing a Module cell are dropped.
 */
export function parseModulesTable(md: string, hubRoot: string, confidentialSegments: Set<string>): ModuleRow[] {
  const { header, rows } = parseMdTableSectionWithHeader(md, 'Modules');
  if (header.length === 0) return [];

  const col = (name: string) => header.indexOf(name);
  const iName = col('Module');
  const iTier = col('Tier');
  const iPurpose = col('Purpose');
  const iContract = col('Contract');
  const iPrd = col('PRD home');
  const iProject = col('Project');
  if (iName < 0) return [];

  const at = (cells: string[], i: number) => (i >= 0 ? (cells[i] ?? '') : '');
  return rows
    .map((cells): ModuleRow | null => {
      const name = at(cells, iName);
      if (!name) return null;
      return {
        name,
        tier: at(cells, iTier),
        purpose: at(cells, iPurpose),
        prdHome: at(cells, iPrd),
        project: at(cells, iProject),
        contract: parseContractCell(at(cells, iContract), hubRoot, confidentialSegments),
      };
    })
    .filter((row): row is ModuleRow => row !== null);
}

/**
 * Reads operations.md from the hub root and parses the `## Modules` table.
 * Read-only; a missing operations.md yields `{found: false, rows: []}` (logged,
 * no throw) so the UI can tell "no registry" from "empty registry".
 */
export function collectModules(hubRoot: string, confidentialSegments: Set<string>): ModulesSlice {
  const path = join(hubRoot, 'operations.md');
  let md: string;
  try {
    md = readFileSync(path, 'utf8');
  } catch (err) {
    console.warn(`[modules] could not read ${path} -- modules slice empty. ${err}`);
    return { found: false, rows: [] };
  }
  return { found: true, rows: parseModulesTable(md, hubRoot, confidentialSegments) };
}
