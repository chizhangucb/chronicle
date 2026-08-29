// Windowed readings for the Memory page's four analytics lanes (CHI-385
// parity, ported from Varde src/lib/memory.ts). They read the server slice's
// pre-computed rot/growth/usage/connectivity shapes: usage and growth follow
// the page window, rot is threshold-based (the collector's flat 30d default,
// config-tunable), and connectivity is structural. Each lane says which in its
// meta line. Keyed to Chronicle's shared RangeBar vocabulary (RangeKey).
import type { MemorySliceView } from '../../api.js';
import type { RangeKey } from '../../RangeBar.js';

type Slice = MemorySliceView | null | undefined;

/** Epoch-ms cutoff for a window. 'today' starts at local midnight; 'all' is 0. */
export function windowCutoff(range: RangeKey, now: Date = new Date()): number {
  if (range === 'all') return 0;
  if (range === 'today') return new Date(now).setHours(0, 0, 0, 0);
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  return now.getTime() - days * 86_400_000;
}

/** A short label for a window ('7d', '30d', 'today', 'all time'). */
export function rangeWord(range: RangeKey): string {
  return range === 'today' ? 'today' : range === 'all' ? 'all time' : range;
}

const dayMs = (day: string): number => new Date(`${day}T12:00:00`).getTime();

// ---------------------------------------------------------------------------
// Rot ("freshness"): the age distribution IS the reading.

export interface RotLane {
  /** Null when the projection predates the read, or nothing is measured. */
  thresholdDays: number | null;
  measured: number;
  buckets: { label: string; count: number }[];
  fresh: number;
  oldCount: number;
  oldest: { name: string; path?: string; kind?: string; ageDays: number }[];
  flagged: { name: string; path?: string; kind?: string; ageDays: number }[];
}

export function rotLane(memory: Slice): RotLane {
  const rot = memory?.rot;
  if (!rot?.buckets || !rot.measured) {
    return { thresholdDays: null, measured: 0, buckets: [], fresh: 0, oldCount: 0, oldest: [], flagged: [] };
  }
  const oldCount = rot.oldCount ?? 0;
  return {
    thresholdDays: rot.thresholdDays ?? null,
    measured: rot.measured,
    buckets: rot.buckets.map((b) => ({ label: b.label, count: b.count })),
    fresh: rot.measured - oldCount,
    oldCount,
    oldest: (rot.oldest ?? []).map((n) => ({
      name: n.name ?? n.path ?? 'unnamed',
      path: n.path,
      kind: n.kind,
      ageDays: n.ageDays ?? 0,
    })),
    flagged: (rot.flagged ?? []).map((n) => ({
      name: n.name ?? n.path ?? 'unnamed',
      path: n.path,
      kind: n.kind,
      ageDays: n.ageDays ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Usage: three deterministic channels, windowed from the per-day buckets.

export interface UsageLane {
  /** Notes touched inside the window, most-touched first. */
  touched: {
    note: string;
    name: string;
    path?: string;
    kind?: string;
    count: number;
    transcript: number;
    wikilink: number;
    briefing: number;
  }[];
  totals: { transcript: number; wikilink: number; briefing: number };
  /** 0..1 share of the LIVING base touched in the window; null when unknown. */
  baseShare: number | null;
}

export function usageLane(memory: Slice, cutoff: number): UsageLane {
  const totals = { transcript: 0, wikilink: 0, briefing: 0 };
  const touched: UsageLane['touched'] = [];
  let livingTouched = 0;
  for (const note of memory?.usage?.perNote ?? []) {
    let transcript = 0;
    let wikilink = 0;
    let briefing = 0;
    for (const day of note.days ?? []) {
      if (dayMs(day.day) < cutoff) continue;
      transcript += day.transcript ?? 0;
      wikilink += day.wikilink ?? 0;
      briefing += day.briefing ?? 0;
    }
    const count = transcript + wikilink + briefing;
    if (count === 0) continue;
    totals.transcript += transcript;
    totals.wikilink += wikilink;
    totals.briefing += briefing;
    if (note.tier === 'living') livingTouched++;
    touched.push({
      note: note.note ?? note.name ?? '',
      name: note.name ?? note.note ?? 'unnamed',
      path: note.path,
      kind: note.kind,
      count,
      transcript,
      wikilink,
      briefing,
    });
  }
  touched.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const base = memory?.stats?.living ?? 0;
  return { touched, totals, baseShare: base > 0 ? livingTouched / base : null };
}

/**
 * Windowed touches per node id, for the canvas usage-heat lens and the inspect
 * panel. Keys are the collector's node ids (usage perNote.note); the canvas
 * matches nodes by id directly.
 */
export function usageTouchMap(memory: Slice, cutoff: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const note of memory?.usage?.perNote ?? []) {
    const key = note.note ?? note.path ?? note.name;
    if (!key) continue;
    let total = 0;
    for (const day of note.days ?? []) {
      if (dayMs(day.day) < cutoff) continue;
      total += (day.transcript ?? 0) + (day.wikilink ?? 0) + (day.briefing ?? 0);
    }
    if (total > 0) map.set(key, total);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Growth: births from the birthtime-derived daily series.

export interface GrowthLane {
  /** Living notes born inside the window; null when the series is absent. */
  births: number | null;
  /** The living base at the newest point. */
  base: number | null;
  /** In-window series for the sparkline, oldest first. */
  series: { day: string; total: number; births: number }[];
  /** Null = tracking has not accrued two snapshots yet (honest label). */
  deletions: { total: number; since: string } | null;
}

export function growthLane(memory: Slice, cutoff: number): GrowthLane {
  const all = memory?.growth?.series ?? [];
  if (!all.length) return { births: null, base: null, series: [], deletions: memory?.growth?.deletions ?? null };
  const inWindow = all.filter((p) => dayMs(p.day) >= cutoff);
  const series = inWindow.length >= 2 ? inWindow : all.slice(-2);
  return {
    births: inWindow.reduce((sum, p) => sum + (p.births ?? 0), 0),
    base: all[all.length - 1]?.total ?? null,
    series,
    deletions: memory?.growth?.deletions ?? null,
  };
}

// ---------------------------------------------------------------------------
// Connectivity (orphan v2): the collector emits the neutral structural
// "unlinked" list; ORPHANS are derived here as unlinked AND zero touches in the
// selected window, so the headline follows the window selector.

export interface ConnectivityLane {
  /** Living notes with zero links AND zero touches in the window. */
  orphans: number;
  /** Living notes with zero links, touched or not: a neutral count. */
  unlinked: number;
  /** 0..1 of the living base; null when the base is unknown. */
  orphanShare: number | null;
  orphanList: { name: string; kind: string; path?: string }[];
  hubs: { name: string; links: number; path?: string; delta: number | null }[];
  deadLinks: number;
  deadLinkList: { source: string; sourcePath?: string; target: string }[];
  /** "history accrues from <day>" until deltas can be computed; null = live. */
  deltaAccruesFrom: string | null;
}

/** Windowed link-degree delta key for a range; null = no delta for the range. */
function deltaKey(range: RangeKey): 'd7' | 'd30' | 'd90' | null {
  return range === '7d' ? 'd7' : range === '30d' ? 'd30' : range === '90d' ? 'd90' : null;
}

export function connectivityLane(memory: Slice, cutoff: number, range: RangeKey): ConnectivityLane {
  const conn = memory?.connectivity;
  const living = memory?.stats?.living ?? 0;

  // Path-keyed windowed touches for the orphan derivation.
  const touchesByPath = new Map<string, number>();
  for (const note of memory?.usage?.perNote ?? []) {
    if (!note.path) continue;
    let total = 0;
    for (const day of note.days ?? []) {
      if (dayMs(day.day) < cutoff) continue;
      total += (day.transcript ?? 0) + (day.wikilink ?? 0) + (day.briefing ?? 0);
    }
    if (total > 0) touchesByPath.set(note.path, total);
  }

  const unlinkedList = (conn?.unlinked?.list ?? []).map((o) => ({
    name: o.name ?? 'unnamed',
    kind: o.kind ?? 'note',
    path: o.path,
  }));
  const orphanList = unlinkedList.filter((o) => !o.path || !touchesByPath.has(o.path));

  const key = deltaKey(range);
  const byPath = conn?.degreeDeltas?.byPath;
  const deltaFor = (path: string | undefined): number | null => {
    if (!key || !path || !byPath) return null;
    const d = byPath[path]?.[key];
    return typeof d === 'number' ? d : null;
  };
  // The honest fallback line: history exists but cannot reach this window yet.
  const anyDelta =
    key != null &&
    byPath != null &&
    Object.values(byPath).some((d) => typeof d?.[key] === 'number');

  return {
    orphans: orphanList.length,
    unlinked: conn?.unlinked?.count ?? 0,
    orphanShare: living > 0 ? orphanList.length / living : null,
    orphanList,
    hubs: (conn?.mostConnected ?? []).map((h) => ({
      name: h.name ?? 'unnamed',
      links: h.links ?? 0,
      path: h.path,
      delta: deltaFor(h.path),
    })),
    deadLinks: conn?.deadLinks?.count ?? 0,
    deadLinkList: (conn?.deadLinks?.list ?? []).map((d) => ({
      source: d.source ?? 'unnamed',
      sourcePath: d.sourcePath,
      target: d.target ?? '',
    })),
    deltaAccruesFrom: key != null && !anyDelta ? (conn?.degreeDeltas?.accruesFrom ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Scope line copy: built from the echo, never restated.

export interface ScopeLine {
  living: number;
  dirNames: string[];
  more: number;
}

/** "measuring N living notes across wiki, governance, +4 more". */
export function scopeLine(memory: Slice, maxNames = 2): ScopeLine {
  const livingDirs = (memory?.scope?.dirs ?? [])
    .filter((d) => d.tier === 'living')
    .map((d) => d.dir);
  return {
    living: memory?.stats?.living ?? 0,
    dirNames: livingDirs.slice(0, maxNames),
    more: Math.max(0, livingDirs.length - maxNames),
  };
}
