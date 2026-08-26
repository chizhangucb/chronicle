/* eslint-disable @typescript-eslint/no-explicit-any -- reason below */
/**
 * Why `any` is allowed: parses the committed safety-gaps register, a
 * hand-authored JSON whose shape is checked at runtime by asGap, not by a type.
 *
 * Safety-gaps slice (ported from Varde): the curated, synthetic-safe register in
 * data/safety-gaps.json plus a small live-posture summary derived from the
 * safetyNet slice. Splits the register into the two panel sections (actionable
 * vs watch). Never invents gaps; never grades the gate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SafetyNetSlice } from './safetynet.ts';

export interface GapEntry {
  id: string;
  kind: 'actionable' | 'watch';
  title: string;
  exposure: string;
  acceptedWhy: string;
  acceptedDate: string;
  blastRadius: string;
  closingEdit?: { surface: string; label: string };
  revisitTrigger?: string;
  links: string[];
}

export interface SafetyGapsSlice {
  header: string;
  actionable: GapEntry[];
  watch: GapEntry[];
  posture: {
    classificationRules: number;
    markerCategories: { category: string; count: number }[];
    spendCaps: Record<string, number | null>;
    egressEnabled: boolean;
  };
}

const EMPTY_POSTURE: SafetyGapsSlice['posture'] = {
  classificationRules: 0, markerCategories: [], spendCaps: {}, egressEnabled: true,
};

function asGap(raw: any): GapEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const kind = raw.kind === 'actionable' || raw.kind === 'watch' ? raw.kind : null;
  if (!kind || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
  const gap: GapEntry = {
    id: raw.id, kind, title: raw.title,
    exposure: String(raw.exposure ?? ''), acceptedWhy: String(raw.acceptedWhy ?? ''),
    acceptedDate: String(raw.acceptedDate ?? ''), blastRadius: String(raw.blastRadius ?? ''),
    links: Array.isArray(raw.links) ? raw.links.map(String) : [],
  };
  if (kind === 'actionable') {
    if (typeof raw.closingEdit?.surface !== 'string' || typeof raw.closingEdit?.label !== 'string') {
      // an actionable gap without a closing edit is a register bug: demote to
      // watch rather than render a dead button
      return { ...gap, kind: 'watch', revisitTrigger: 'register entry missing its closingEdit' };
    }
    gap.closingEdit = { surface: raw.closingEdit.surface, label: raw.closingEdit.label };
  } else {
    gap.revisitTrigger = String(raw.revisitTrigger ?? '');
  }
  return gap;
}

function posture(safetyNet: SafetyNetSlice, egressEnabled: boolean): SafetyGapsSlice['posture'] {
  const caps: Record<string, number | null> = {};
  if (safetyNet.gateConfig) {
    caps.spend_per_tx_cap = safetyNet.gateConfig.spend_per_tx_cap;
    caps.spend_per_session_cap = safetyNet.gateConfig.spend_per_session_cap;
  }
  return {
    classificationRules: safetyNet.classification?.tools.length ?? 0,
    markerCategories: safetyNet.markers.categories,
    spendCaps: caps,
    egressEnabled,
  };
}

/** Reads data/safety-gaps.json from the SHIPPED register (repoRoot/data) and
 * derives live posture from the safetyNet slice. The register is committed and
 * synthetic-safe, so it is read from Chronicle's own repo, never the hub. */
export function collectSafetyGaps(registerPath: string, safetyNet: SafetyNetSlice, egressEnabled: boolean): SafetyGapsSlice {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(registerPath, 'utf-8'));
  } catch {
    return { header: '', actionable: [], watch: [], posture: posture(safetyNet, egressEnabled) };
  }
  const gaps: GapEntry[] = (Array.isArray(raw?.gaps) ? raw.gaps : []).map(asGap).filter((g: GapEntry | null): g is GapEntry => g !== null);
  return {
    header: String(raw?.header ?? ''),
    actionable: gaps.filter((g) => g.kind === 'actionable'),
    watch: gaps.filter((g) => g.kind === 'watch'),
    posture: safetyNet ? posture(safetyNet, egressEnabled) : EMPTY_POSTURE,
  };
}
