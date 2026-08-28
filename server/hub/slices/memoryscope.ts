/**
 * Memory scope: which hub files count as knowledge, and in which tier
 * (Phase 7.5 M6, the Q16-Q18 closure).
 *
 * Three tiers, resolved from glob patterns relative to the hub root:
 *   - living: maintained-in-place knowledge. Measured for usage, rot, growth.
 *   - historical: dated append-only records. Drawn and used as evidence;
 *     they NEVER rot (an old decision is history, not staleness) and never
 *     count toward growth (machine output must not masquerade as knowledge).
 *   - excluded: not measured at all. Anything no pattern matches is excluded,
 *     so a stranger's hub degrades to an honest configure-me state rather
 *     than fake numbers.
 *
 * Shipped defaults are the AIOS conventions; aggregator config
 * (memory.scope) overrides them per tier, and the memory-scope gate surface
 * edits that config through the standard confirm flow.
 *
 * Pattern language (deliberately tiny, no dependency):
 *   - `*`  matches within one path segment
 *   - `**` matches across segments
 *   - a pattern that matches an ANCESTOR directory of a path matches the
 *     path too ("wiki" covers wiki/entities/foo.md), which is what makes the
 *     scope panel read as a folder list rather than regex soup.
 * Precedence: excluded beats historical beats living; unmatched -> excluded.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MemoryTier = "living" | "historical" | "excluded";

export interface MemoryScopePatterns {
  living: string[];
  historical: string[];
  excluded: string[];
}

export interface MemoryConfig {
  scope: MemoryScopePatterns;
  /** Flat aging threshold in days (Q22: one flat 30d default, per Chi). */
  rotDays: number;
  /** Optional per-kind overrides, e.g. { governance: 365 }. Ships empty. */
  rotDaysByKind: Record<string, number>;
}

/** The locked AIOS mapping (workstate Q16-Q18, Q21-Q22 tier calls). */
export const DEFAULT_MEMORY_SCOPE: MemoryScopePatterns = {
  living: [
    "wiki",
    "governance",
    "skills",
    "context",
    "contacts",
    "references",
    // Root registry files (operations.md, model-routing.md, CLAUDE.md, ...).
    "*.md",
  ],
  historical: [
    // `records/decisions*` matches decisions.jsonl and the old decisions.md
    // shards during the bake; `records/sessions*` matches sessions.jsonl and
    // the old sessions_index.md (CHI-313 markdown -> jsonl migration).
    "records/decisions*",
    "records/sessions*",
    "records/brainstorms",
    "records/reports",
    "archives",
    // Dated ingest material inside the wiki: never rots (Q21/Q22).
    "wiki/sources",
    "wiki/raw",
    // Archived evidence (CHI-385): densely cross-linked but not living
    // knowledge, so it reads as records, not the most-connected living notes.
    "wiki/annex",
  ],
  // Generic nisse-shaped defaults; an operator overrides via the memory-scope
  // config. Confidential/next-ventures do NOT need to be listed here: the
  // walk-level hard prune (CONFIDENTIAL_SEGMENTS in memorygraph.ts) excludes them
  // in the public projection regardless of any scope config.
  excluded: [
    "plans",
    // Pipeline machinery: counting it would fake freshness and growth.
    "wiki/metadata",
    "node_modules",
    "dist",
  ],
};

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  scope: DEFAULT_MEMORY_SCOPE,
  rotDays: 30,
  rotDaysByKind: {},
};

// ---------------------------------------------------------------------------
// Config loading (CHI-339): the memory-scope gate surface (server/gate/
// surfaces.ts) writes ${HOME}/.chronicle/memory-scope.json, nested under a
// `memory` key to match the `memory-scope` schema in server/gate/validate.ts
// (landed 1b). This is the read side: never throws, per-tier fallback to the
// shipped defaults so a partial or malformed file degrades gracefully rather
// than crashing a memory read.

/** Where the memory-scope config lives. Always the real ${HOME} (the gate
 * surface's target template), never CHRONICLE_DATA_DIR-relative. */
export function memoryScopeConfigPath(): string {
  return join(homedir(), '.chronicle', 'memory-scope.json');
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** Load the resolved memory config: the on-disk file's `memory` block layered
 * over the shipped defaults, or the defaults untouched when the file is
 * absent/unreadable/malformed. Per-tier: an absent or malformed tier list
 * falls back to its own default rather than discarding the whole scope. */
export function loadMemoryConfig(path: string = memoryScopeConfigPath()): { config: MemoryConfig; source: "defaults" | "config" } {
  try {
    if (!existsSync(path)) return { config: DEFAULT_MEMORY_CONFIG, source: "defaults" };
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const memory = parsed?.memory;
    if (typeof memory !== "object" || memory === null || Array.isArray(memory)) {
      return { config: DEFAULT_MEMORY_CONFIG, source: "defaults" };
    }
    const rawScope = memory.scope;
    const scope: MemoryScopePatterns = {
      living: isStringArray(rawScope?.living) ? rawScope.living : DEFAULT_MEMORY_SCOPE.living,
      historical: isStringArray(rawScope?.historical) ? rawScope.historical : DEFAULT_MEMORY_SCOPE.historical,
      excluded: isStringArray(rawScope?.excluded) ? rawScope.excluded : DEFAULT_MEMORY_SCOPE.excluded,
    };
    const rotDays = typeof memory.rotDays === "number" && Number.isFinite(memory.rotDays) && memory.rotDays > 0
      ? memory.rotDays
      : DEFAULT_MEMORY_CONFIG.rotDays;
    const rotDaysByKind = typeof memory.rotDaysByKind === "object" && memory.rotDaysByKind !== null && !Array.isArray(memory.rotDaysByKind)
      ? memory.rotDaysByKind as Record<string, number>
      : {};
    return { config: { scope, rotDays, rotDaysByKind }, source: "config" };
  } catch {
    return { config: DEFAULT_MEMORY_CONFIG, source: "defaults" };
  }
}

/** Compile one scope pattern to a full-path regex (no ancestor logic here). */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

const regexCache = new Map<string, RegExp>();
function compiled(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = patternToRegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

/**
 * Does `pattern` match `relPath`, either exactly or as an ancestor directory
 * (segment boundary, so "wiki" never matches "wikipedia.md")?
 */
export function patternMatches(pattern: string, relPath: string): boolean {
  const re = compiled(pattern);
  if (re.test(relPath)) return true;
  // Ancestor check: try every directory prefix of the path.
  let idx = relPath.indexOf("/");
  while (idx !== -1) {
    if (re.test(relPath.slice(0, idx))) return true;
    idx = relPath.indexOf("/", idx + 1);
  }
  return false;
}

/** Tier for one hub-relative path. Excluded > historical > living; unmatched -> excluded. */
export function tierFor(relPath: string, scope: MemoryScopePatterns): MemoryTier {
  if (scope.excluded.some((p) => patternMatches(p, relPath))) return "excluded";
  if (scope.historical.some((p) => patternMatches(p, relPath))) return "historical";
  if (scope.living.some((p) => patternMatches(p, relPath))) return "living";
  return "excluded";
}

/** One pattern segment ("decisions*") to a regex over one path segment. */
function segmentRegExp(segment: string): RegExp {
  const escaped = segment
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`);
}

/**
 * Could `pattern` match anything at or under `relDir`? Segment-by-segment:
 * `**` opens everything; when the pattern runs out first it is an ancestor
 * (subtree covered), when the dir runs out first the pattern reaches deeper.
 * Either way the walk must descend.
 */
function patternCouldMatchWithin(pattern: string, relDir: string): boolean {
  const ps = pattern.split("/");
  const ds = relDir.split("/");
  for (let i = 0; i < ps.length && i < ds.length; i++) {
    if (ps[i].includes("**")) return true;
    if (!segmentRegExp(ps[i]).test(ds[i])) return false;
  }
  return true;
}

/**
 * May anything under this directory land in a measured tier? Used to prune
 * the walk so excluded project folders (which can hold whole codebases) are
 * never descended into. Pruning is a perf concern only: tierFor still
 * decides per file, so a walked-but-excluded dir yields nothing either way.
 */
export function dirMayContainScoped(relDir: string, scope: MemoryScopePatterns): boolean {
  return [...scope.living, ...scope.historical].some((p) => patternCouldMatchWithin(p, relDir));
}

// ---------------------------------------------------------------------------
// Kinds

/**
 * Kind for a scoped note, from its hub-relative path (Q15 definitions round:
 * wiki page kinds, skill, contact, context, reference, governance, registry;
 * records keep decision/session/brainstorm/report kinds).
 */
export function kindFor(relPath: string, tier: MemoryTier): string {
  const seg = relPath.split("/");
  if (tier === "historical") {
    if (seg[0] === "records") {
      if (seg[1]?.startsWith("decisions")) return "decision";
      if (seg[1]?.startsWith("sessions")) return "session";
      if (seg[1] === "brainstorms") return "brainstorm";
      if (seg[1] === "reports") return "report";
      return "record";
    }
    if (seg[0] === "archives") return "archive";
    if (seg[0] === "wiki" && (seg[1] === "sources" || seg[1] === "raw")) return "source";
    return "record";
  }
  if (seg[0] === "wiki") {
    // annex mirrors the living structure one level down (Q21).
    const sub = seg[1] === "annex" ? seg[2] : seg[1];
    if (sub === "entities") return "entity";
    if (sub === "concepts") return "concept";
    if (sub === "synthesis") return "synthesis";
    return "wiki";
  }
  if (seg[0] === "skills") return "skill";
  if (seg[0] === "contacts") return "contact";
  if (seg[0] === "context") return "context";
  if (seg[0] === "references") return "reference";
  if (seg[0] === "governance") return "governance";
  if (seg.length === 1) return "registry";
  return "note";
}

// ---------------------------------------------------------------------------
// Rot (Q22): living notes only; records never rot.

export interface RotBucket {
  label: string;
  fromDays: number;
  /** Exclusive upper bound; null = open-ended. */
  toDays: number | null;
  count: number;
}

export interface RotEntry {
  name: string;
  path?: string;
  kind: string;
  ageDays: number;
}

export interface RotRead {
  thresholdDays: number;
  /** Per-kind thresholds actually applied (config overrides over the flat default). */
  thresholdsByKind: Record<string, number>;
  buckets: RotBucket[];
  /** Notes older than their threshold, oldest first (top N with path+age). */
  oldest: RotEntry[];
  oldCount: number;
  /** Compound rot: old AND unused (no touch in the threshold window) AND unlinked. */
  flagged: RotEntry[];
  measured: number;
}

const BUCKET_EDGES: { label: string; from: number; to: number | null }[] = [
  { label: "0-7d", from: 0, to: 8 },
  { label: "8-30d", from: 8, to: 31 },
  { label: "31-90d", from: 31, to: 91 },
  { label: "91-180d", from: 91, to: 181 },
  { label: "180d+", from: 181, to: null },
];

export interface LivingNoteRead {
  id: string;
  name: string;
  path?: string;
  kind: string;
  /** Epoch ms of last edit; NaN when unmeasurable. */
  mtimeMs: number;
}

export function computeRot(
  living: LivingNoteRead[],
  opts: {
    now: number;
    rotDays: number;
    rotDaysByKind: Record<string, number>;
    /** Note ids with at least one usage touch inside the threshold window. */
    touchedIds: Set<string>;
    /** Note ids with at least one link in or out. */
    linkedIds: Set<string>;
    topN?: number;
  },
): RotRead {
  const topN = opts.topN ?? 15;
  const dated = living.filter((n) => Number.isFinite(n.mtimeMs));
  const buckets: RotBucket[] = BUCKET_EDGES.map((edge) => ({
    label: edge.label,
    fromDays: edge.from,
    toDays: edge.to,
    count: 0,
  }));
  const thresholdOf = (kind: string): number => opts.rotDaysByKind[kind] ?? opts.rotDays;
  const old: RotEntry[] = [];
  const flagged: RotEntry[] = [];
  for (const note of dated) {
    const ageDays = Math.max(0, Math.floor((opts.now - note.mtimeMs) / 86_400_000));
    for (const bucket of buckets) {
      if (ageDays >= bucket.fromDays && (bucket.toDays === null || ageDays < bucket.toDays)) {
        bucket.count++;
        break;
      }
    }
    if (ageDays > thresholdOf(note.kind)) {
      const entry: RotEntry = { name: note.name, path: note.path, kind: note.kind, ageDays };
      old.push(entry);
      if (!opts.touchedIds.has(note.id) && !opts.linkedIds.has(note.id)) flagged.push(entry);
    }
  }
  old.sort((a, b) => b.ageDays - a.ageDays);
  flagged.sort((a, b) => b.ageDays - a.ageDays);
  return {
    thresholdDays: opts.rotDays,
    thresholdsByKind: opts.rotDaysByKind,
    buckets,
    oldest: old.slice(0, topN),
    oldCount: old.length,
    flagged: flagged.slice(0, topN),
    measured: dated.length,
  };
}

// ---------------------------------------------------------------------------
// Growth (Q23): living tier only, births from file birthtimes.

export interface GrowthPointV2 {
  day: string;
  /** Living notes already born by the end of this day. */
  total: number;
  /** Notes born on this day. */
  births: number;
}

export interface GrowthRead {
  /** Daily points over the trailing window, oldest first. */
  series: GrowthPointV2[];
  birthsByWindow: { "7": number; "30": number; "90": number; "180": number };
  /** Null until two snapshots exist (deletion tracking accrues going forward). */
  deletions: { total: number; since: string } | null;
}

const dayKeyUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function computeGrowth(
  births: number[],
  livingTotal: number,
  now: number,
  windowDays = 180,
): Omit<GrowthRead, "deletions"> {
  const valid = births.filter((b) => Number.isFinite(b) && b > 0).sort((a, b) => a - b);
  const perDay = new Map<string, number>();
  for (const b of valid) {
    const day = dayKeyUtc(b);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const start = now - (windowDays - 1) * 86_400_000;
  // Notes born before the window seed the base so the curve starts at truth.
  let running = valid.filter((b) => b < new Date(dayKeyUtc(start)).getTime()).length;
  const series: GrowthPointV2[] = [];
  for (let i = 0; i < windowDays; i++) {
    const day = dayKeyUtc(start + i * 86_400_000);
    const births_ = perDay.get(day) ?? 0;
    running += births_;
    series.push({ day, total: running, births: births_ });
  }
  // Deleted notes leave no birthtime behind, so the curve's end can undercount
  // the base; pin the final point to the real living total instead of lying.
  if (series.length) series[series.length - 1].total = livingTotal;
  const windowCount = (days: number): number =>
    valid.filter((b) => b >= now - days * 86_400_000).length;
  return {
    series,
    birthsByWindow: { "7": windowCount(7), "30": windowCount(30), "90": windowCount(90), "180": windowCount(180) },
  };
}

// ---------------------------------------------------------------------------
// Usage (Q20): three deterministic channels merged per note per day.

export type UsageChannel = "transcript" | "wikilink" | "briefing";

export interface RawTouch {
  /** Epoch ms. */
  ts: number;
  noteId: string;
  channel: UsageChannel;
}

export interface UsageDayBucket {
  day: string;
  transcript: number;
  wikilink: number;
  briefing: number;
}

export interface UsageNoteRead {
  note: string;
  name: string;
  path?: string;
  kind: string;
  tier: MemoryTier;
  transcript: number;
  wikilink: number;
  briefing: number;
  total: number;
  /** Per-day per-channel counts so the UI can window without re-parsing. */
  days: UsageDayBucket[];
}

export interface UsageRead {
  totals: { transcript: number; wikilink: number; briefing: number };
  /** Every touched note, most-touched first. */
  perNote: UsageNoteRead[];
}

export function mergeTouches(
  touches: RawTouch[],
  noteMeta: Map<string, { name: string; path?: string; kind: string; tier: MemoryTier }>,
): UsageRead {
  const totals = { transcript: 0, wikilink: 0, briefing: 0 };
  const byNote = new Map<string, UsageNoteRead & { dayMap: Map<string, UsageDayBucket> }>();
  for (const touch of touches) {
    if (!Number.isFinite(touch.ts)) continue;
    const meta = noteMeta.get(touch.noteId);
    if (!meta) continue; // a touch on nothing we measure is not usage
    totals[touch.channel]++;
    let entry = byNote.get(touch.noteId);
    if (!entry) {
      entry = {
        note: touch.noteId,
        name: meta.name,
        path: meta.path,
        kind: meta.kind,
        tier: meta.tier,
        transcript: 0,
        wikilink: 0,
        briefing: 0,
        total: 0,
        days: [],
        dayMap: new Map(),
      };
      byNote.set(touch.noteId, entry);
    }
    entry[touch.channel]++;
    entry.total++;
    const day = dayKeyUtc(touch.ts);
    let bucket = entry.dayMap.get(day);
    if (!bucket) {
      bucket = { day, transcript: 0, wikilink: 0, briefing: 0 };
      entry.dayMap.set(day, bucket);
    }
    bucket[touch.channel]++;
  }
  const perNote = [...byNote.values()]
    .map(({ dayMap, ...rest }) => ({
      ...rest,
      days: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { totals, perNote };
}

// ---------------------------------------------------------------------------
// Connectivity (Q24-Q26): orphans are LIVING-only; dead links are named.

export interface ConnectivityNode {
  id: string;
  name: string;
  path?: string;
  kind: string;
  tier: MemoryTier;
}

export interface ConnectivityRead {
  /**
   * Living notes with zero links in AND out: a neutral structural count
   * (orphan v2, N4). The UI derives ORPHANS from this list as the subset with
   * zero touches in the selected window; "unlinked" alone is not a problem.
   * Records are excluded entirely: a dated record needs no links to be
   * healthy.
   */
  unlinked: { count: number; list: { name: string; kind: string; path?: string }[] };
  mostConnected: { name: string; links: number; path?: string }[];
  deadLinks: { count: number; list: { source: string; sourcePath?: string; target: string }[] };
  /** Link-degree movement from accrued snapshots; absent until history exists. */
  degreeDeltas?: DegreeDeltas;
}

// ---------------------------------------------------------------------------
// Link-degree history (N4, Q14): changed-rows-only snapshots accrued per scan,
// daily granularity for 90 days then weekly, powering windowed connectivity
// deltas ("149 links · +12 in 30d"). Pure functions here; file IO in
// memorygraph.ts beside the deletion snapshot.

export interface DegreeHistoryFile {
  version: 1;
  /** Day the history started accruing; the UI's honest "history accrues from". */
  firstDay: string;
  /**
   * Changed rows only: each day maps path -> degree for paths whose degree
   * differs from the reconstructed previous state (0 = the note lost all
   * links or left scope). Reconstruction applies days in ascending order.
   */
  days: Record<string, Record<string, number>>;
}

export interface DegreeDeltas {
  accruesFrom: string;
  /** Windowed movement per path; null when history does not reach that far. */
  byPath: Record<string, { d7: number | null; d30: number | null; d90: number | null }>;
}

/** Degree state reconstructed from all recorded days <= atDay; null when the
 * history does not reach back to atDay (started after it). */
export function degreeStateAt(
  history: DegreeHistoryFile,
  atDay: string,
): Map<string, number> | null {
  if (history.firstDay > atDay) return null;
  const state = new Map<string, number>();
  for (const day of Object.keys(history.days).sort()) {
    if (day > atDay) break;
    for (const [path, deg] of Object.entries(history.days[day])) {
      if (deg === 0) state.delete(path);
      else state.set(path, deg);
    }
  }
  return state;
}

/** Appends today's changed rows to the history (mutating a copy) and compacts
 * days older than 90d to one kept day per ISO week (diffs merged forward). */
export function appendDegreeDay(
  history: DegreeHistoryFile | null,
  degreesByPath: Map<string, number>,
  today: string,
): DegreeHistoryFile {
  const base: DegreeHistoryFile = history ?? { version: 1, firstDay: today, days: {} };
  const prev = degreeStateAt(base, today) ?? new Map<string, number>();
  const changed: Record<string, number> = {};
  for (const [path, deg] of degreesByPath) {
    if ((prev.get(path) ?? 0) !== deg) changed[path] = deg;
  }
  for (const path of prev.keys()) {
    if (!degreesByPath.has(path)) changed[path] = 0;
  }
  const days = { ...base.days };
  // Same-day re-runs replace the day's diff (recompute against the state
  // reconstructed WITHOUT today, which degreeStateAt already gave us only if
  // today was absent; drop then recompute to stay idempotent).
  if (days[today]) {
    delete days[today];
    const prevNoToday = degreeStateAt({ ...base, days }, today) ?? new Map<string, number>();
    for (const key of Object.keys(changed)) delete changed[key];
    for (const [path, deg] of degreesByPath) {
      if ((prevNoToday.get(path) ?? 0) !== deg) changed[path] = deg;
    }
    for (const path of prevNoToday.keys()) {
      if (!degreesByPath.has(path)) changed[path] = 0;
    }
  }
  if (Object.keys(changed).length) days[today] = changed;
  return compactDegreeHistory({ version: 1, firstDay: base.firstDay, days }, today);
}

/** ISO week key (YYYY-Www) for compaction. */
function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const target = new Date(d);
  target.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Days older than 90d collapse to one kept day per ISO week; the dropped
 * days' diffs merge forward into the kept day (later values win). */
export function compactDegreeHistory(
  history: DegreeHistoryFile,
  today: string,
): DegreeHistoryFile {
  const cutoffMs = new Date(`${today}T00:00:00Z`).getTime() - 90 * 86_400_000;
  const days = Object.keys(history.days).sort();
  const out: Record<string, Record<string, number>> = {};
  const weekMerged = new Map<string, { lastDay: string; diff: Record<string, number> }>();
  for (const day of days) {
    if (new Date(`${day}T00:00:00Z`).getTime() >= cutoffMs) {
      out[day] = history.days[day];
      continue;
    }
    const week = isoWeek(day);
    const bucket = weekMerged.get(week) ?? { lastDay: day, diff: {} };
    Object.assign(bucket.diff, history.days[day]);
    bucket.lastDay = day;
    weekMerged.set(week, bucket);
  }
  for (const { lastDay, diff } of weekMerged.values()) out[lastDay] = diff;
  return { version: 1, firstDay: history.firstDay, days: out };
}

/** Windowed deltas for the current degrees against reconstructed history. */
export function computeDegreeDeltas(
  history: DegreeHistoryFile,
  degreesByPath: Map<string, number>,
  today: string,
): DegreeDeltas {
  const dayBefore = (w: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - w);
    return d.toISOString().slice(0, 10);
  };
  const states: Record<"d7" | "d30" | "d90", Map<string, number> | null> = {
    d7: degreeStateAt(history, dayBefore(7)),
    d30: degreeStateAt(history, dayBefore(30)),
    d90: degreeStateAt(history, dayBefore(90)),
  };
  const byPath: DegreeDeltas["byPath"] = {};
  for (const [path, deg] of degreesByPath) {
    if (deg <= 0) continue;
    byPath[path] = {
      d7: states.d7 ? deg - (states.d7.get(path) ?? 0) : null,
      d30: states.d30 ? deg - (states.d30.get(path) ?? 0) : null,
      d90: states.d90 ? deg - (states.d90.get(path) ?? 0) : null,
    };
  }
  return { accruesFrom: history.firstDay, byPath };
}

export function computeConnectivity(
  nodes: ConnectivityNode[],
  links: { source: string; target: string }[],
  deadLinks: { source: string; sourcePath?: string; target: string }[],
  opts?: { topN?: number; listCap?: number },
): ConnectivityRead {
  const topN = opts?.topN ?? 10;
  const listCap = opts?.listCap ?? 200;
  const degree = new Map<string, number>();
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }
  const unlinkedNodes = nodes.filter((n) => n.tier === "living" && !degree.has(n.id));
  // Living-only (CHI-385): "most connected" is a living-knowledge health read,
  // like orphans/unlinked above it. Records (dated evidence, incl. the archived
  // wiki/annex tree) are densely cross-linked but are not the living hubs a
  // reader wants surfaced.
  const mostConnected = nodes
    .filter((n) => n.tier === "living" && (degree.get(n.id) ?? 0) > 0)
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.name.localeCompare(b.name))
    .slice(0, topN)
    .map((n) => ({ name: n.name, links: degree.get(n.id) ?? 0, path: n.path }));
  return {
    unlinked: {
      count: unlinkedNodes.length,
      list: unlinkedNodes.slice(0, listCap).map((n) => ({ name: n.name, kind: n.kind, path: n.path })),
    },
    mostConnected,
    deadLinks: { count: deadLinks.length, list: deadLinks.slice(0, listCap) },
  };
}
