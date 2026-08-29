import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  DEFAULT_MEMORY_CONFIG,
  appendDegreeDay,
  computeConnectivity,
  computeDegreeDeltas,
  computeGrowth,
  computeRot,
  dirMayContainScoped,
  kindFor,
  mergeTouches,
  tierFor,
  type ConnectivityRead,
  type DegreeHistoryFile,
  type GrowthRead,
  type MemoryConfig,
  type MemoryTier,
  type RawTouch,
  type RotRead,
  type UsageRead,
} from "./memoryscope.ts";

/**
 * Memory collector (Phase 7.5 M6 rebuild): walks the hub's markdown corpus
 * through the memory.scope tier mapping (memoryscope.ts) and emits the
 * projection's `memory` block: the full graph (no silent cap), tiered
 * inventory, rot, growth, usage and connectivity, plus a `scope` echo so the
 * UI's scope panel renders from reality rather than restated copy.
 *
 * Privacy: node names are titles, paths are hub-relative; note BODY text is
 * read only to extract wikilinks and the first heading, and never emitted.
 */

export interface MemGraphNode {
  id: string;
  name: string;
  kind: string;
  tier: MemoryTier;
  val: number;
  color: string;
  path?: string;
  /**
   * When this note was last touched. File-backed nodes carry the file mtime;
   * decisions and sessions carry the date in their own header/row (those are
   * append-only records, their file's mtime is the record file's, not theirs).
   * Absent when no honest timestamp exists.
   */
  mtime?: string;
}

export interface MemGraphLink {
  source: string;
  target: string;
  kind: "cross" | "decision" | "session";
}

export interface DeadLink {
  /** Display name of the note holding the broken wikilink. */
  source: string;
  sourcePath?: string;
  /** The wikilink target that resolves to no existing note. */
  target: string;
}

export interface ScopeEcho {
  /** Where the resolved mapping came from: shipped defaults or user config. */
  source: "defaults" | "config";
  /** At least one measured directory exists on this machine. False renders
   * the configure-me empty state, never fake zeros. */
  configured: boolean;
  tiers: { living: string[]; historical: string[]; excluded: string[] };
  rotDays: number;
  rotDaysByKind: Record<string, number>;
  /** Per-folder note counts over the measured corpus. */
  dirs: { dir: string; tier: MemoryTier; notes: number }[];
}

export interface MemorySlice {
  stats: {
    /** All emitted nodes (living + records). Kept for older consumers. */
    totalFiles: number;
    totalWorkspaces: number;
    /** Living notes older than their rot threshold. */
    stale: number;
    missing: number;
    /** Share of living notes edited within the rot threshold, 0..1. */
    freshness: number;
    /** The canvas draws ALL nodes; this is only a hint for a LITE mode. */
    capSuggested: number;
    totalNotes: number;
    totalLinks: number;
    living: number;
    historical: number;
  };
  scope: ScopeEcho;
  rot: RotRead;
  growth: GrowthRead;
  usage: UsageRead;
  connectivity: ConnectivityRead;
  nodes: MemGraphNode[];
  links: MemGraphLink[];
  /** Living-note timestamps, for windowed views over the whole base. */
  noteDates: { name: string; path?: string; kind: string; mtime: string }[];
}

/** Kind colors for the collector's own node payload; the UI keys its palette
 * off kind as well (src/components/memory/kinds.ts), this is the fallback. */
const KIND_COLOR: Record<string, string> = {
  entity: "#9C7BD4",
  concept: "#9C7BD4",
  synthesis: "#9C7BD4",
  wiki: "#9C7BD4",
  governance: "#5488CB",
  registry: "#5488CB",
  skill: "#B8892F",
  context: "#249781",
  reference: "#6BA05A",
  contact: "#C875A0",
  decision: "#5488CB",
  session: "#249781",
  brainstorm: "#C875A0",
  report: "#6BA05A",
  archive: "#5D655F",
  source: "#5D655F",
};
const FALLBACK_COLOR = "#8a93a3";

/** Hint only: the UI may cap its LITE render here. Nothing is dropped. */
export const CAP_SUGGESTED = 250;

// The confidential segments (loaded from the hub at runtime, CHI-390, and passed
// in) must never contribute nodes in the default (public) mode. This is a hard
// walk-level prune, NOT scope config: user config cannot re-include confidential
// content in the public projection. The includeConfidential mode lifts it
// deliberately, to build the separate confidential projection; it never changes
// default-mode output.

/** Dirs that are never knowledge and can be huge; skipped unconditionally. */
const NOISE_DIRS = new Set(["node_modules", ".git", ".obsidian"]);

function pathIsConfidential(relPath: string, segments: Set<string>): boolean {
  return relPath.split("/").some((segment) => segments.has(segment));
}

/**
 * Recursively lists markdown files under hubRoot, pruning:
 *  - confidential segments (before descending, so nothing under them is read)
 *    unless includeConfidential;
 *  - dot/noise dirs;
 *  - dirs no measured scope pattern could reach (perf only; tierFor still
 *    decides per file).
 * Uses lstatSync (never follows symlinks) and skips any symlink entirely: a
 * symlink inside an included dir could otherwise point at confidential
 * content and bypass the path-based prune. The symlink skip applies in both
 * modes; includeConfidential only lifts the segment prune.
 */
function walkMarkdownFiles(
  root: string,
  hubRoot: string,
  scope: MemoryConfig["scope"],
  includeConfidential: boolean,
  confidentialSegments: Set<string>,
  out: string[] = [],
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || NOISE_DIRS.has(entry)) continue;
    const full = join(root, entry);
    const rel = relative(hubRoot, full);
    if (!includeConfidential && pathIsConfidential(rel, confidentialSegments)) continue; // prune before reading
    let stat;
    try {
      stat = lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue; // never follow; a link could evade the prune
    if (stat.isDirectory()) {
      if (!dirMayContainScoped(rel, scope)) continue;
      walkMarkdownFiles(full, hubRoot, scope, includeConfidential, confidentialSegments, out);
    } else if (entry.endsWith(".md")) {
      out.push(full);
    } else if (entry.endsWith(".jsonl") && relative(hubRoot, root) === "records") {
      // The append-only ledgers (records/decisions.jsonl, records/sessions.jsonl)
      // are the CHI-313 jsonl successors of the old markdown records; they are
      // exploded into per-row nodes below, not read as file nodes.
      out.push(full);
    }
  }
  return out;
}

interface FileStat {
  mtimeMs: number;
  birthtimeMs: number;
}

function statOf(path: string): FileStat | null {
  try {
    const s = lstatSync(path);
    return { mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs };
  } catch {
    return null;
  }
}

/** "2026-08-05: title" header prefixes and session-row dates become epoch ms. */
function dateToMs(text: string): number {
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? new Date(`${match[1]}T12:00:00`).getTime() : Number.NaN;
}

/** First `# Heading` in a markdown file, falling back to a humanized filename. */
function titleFor(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) return match[1].trim();
  return filename
    .replace(/\.md$/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extracts `[[slug]]` or `[[slug|alias]]` wikilink targets from markdown
 * content. Placeholder targets (`[[...]]` and bare dots, template filler, not
 * links) are excluded so they never count as dead links (N4).
 */
export function wikilinkTargets(content: string): string[] {
  const targets: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const target = m[1].trim();
    if (/^\.+$/.test(target) || target.endsWith("/...")) continue;
    targets.push(target);
  }
  return targets;
}

interface SessionRow {
  /** The session stamp: "YYYY-MM-DD HHMM". */
  date: string;
  sessionId: string;
  focus: string;
}

interface DecisionRow {
  date: string | null;
  title: string;
  session: string | null;
  stream: string | null;
  body: string;
}

/** Split a JSONL blob into parsed objects; blank and malformed/partial lines
 * (including an unterminated trailing line) are skipped rather than throwing. */
function parseJsonlLines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      /* skip a malformed or partially-written line */
    }
  }
  return out;
}

/** Parses records/decisions.jsonl (one row per decision block, oldest first). */
function parseDecisionsJsonl(text: string): DecisionRow[] {
  return parseJsonlLines(text)
    .filter((row) => typeof row.title === "string" || typeof row.date === "string")
    .map((row) => ({
      date: typeof row.date === "string" && row.date ? row.date : null,
      title: typeof row.title === "string" ? row.title : "",
      session: typeof row.session === "string" && row.session ? row.session : null,
      stream: typeof row.stream === "string" && row.stream ? row.stream : null,
      body: typeof row.body === "string" ? row.body : "",
    }));
}

/** Parses records/sessions.jsonl (one row per session), newest-first by stamp. */
function parseSessionsJsonl(text: string): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const row of parseJsonlLines(text)) {
    const sessionId = typeof row.session === "string" ? row.session : "";
    if (!sessionId) continue;
    rows.push({
      date: typeof row.stamp === "string" ? row.stamp : "",
      sessionId,
      focus: typeof row.focus === "string" ? row.focus : "",
    });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows;
}

/** Rebuilds a decision's display label from its jsonl row. The parenthetical
 * (session/stream) that the old markdown header carried inline now lives in
 * structured fields; this restores the same human-readable label. */
function decisionLabel(row: DecisionRow): string {
  const head = row.date ? `${row.date}: ${row.title}` : row.title;
  if (!row.session) return head;
  const stream = row.stream ? `, stream: ${row.stream}` : "";
  return `${head} (session ${row.session}${stream})`;
}

// ---------------------------------------------------------------------------
// Deletion snapshots (Q23): accrue from the aggregator's own runs.

interface ScopeSnapshotFile {
  version: 1;
  firstDay: string;
  lastDay: string;
  /** Living-note paths at the last run; the diff against them is a deletion. */
  paths: string[];
  deletionsTotal: number;
}

/**
 * Diffs the current living-path set against the last snapshot and persists
 * the new one. Returns null on the first run (no honest delta yet); the
 * projection says so rather than showing a fake zero.
 */
export function recordDeletions(
  snapshotPath: string,
  currentPaths: string[],
  today: string,
): { total: number; since: string } | null {
  let prev: ScopeSnapshotFile | null = null;
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
    if (parsed?.version === 1 && Array.isArray(parsed.paths)) prev = parsed as ScopeSnapshotFile;
  } catch {
    // first run, or an unreadable file: start fresh rather than crash
  }
  const current = new Set(currentPaths);
  const deleted = prev ? prev.paths.filter((p) => !current.has(p)).length : 0;
  const next: ScopeSnapshotFile = {
    version: 1,
    firstDay: prev?.firstDay ?? today,
    lastDay: today,
    paths: [...current].sort(),
    deletionsTotal: (prev?.deletionsTotal ?? 0) + deleted,
  };
  writeFileSync(snapshotPath, JSON.stringify(next, null, 2) + "\n");
  return prev ? { total: next.deletionsTotal, since: prev.firstDay } : null;
}

// ---------------------------------------------------------------------------
// Collector

export interface CollectMemoryOpts {
  includeConfidential?: boolean;
  /** Scope + thresholds; defaults to the shipped AIOS mapping. The caller
   * (aggregator entry) passes the loaded config. */
  config?: MemoryConfig;
  /** Where the resolved config came from, for the scope echo. */
  configSource?: "defaults" | "config";
  /** Hub-file touches from the spend scan's transcript walk (absolute
   * paths + epoch ms), the usage lane's transcript channel. */
  fileTouches?: { ts: number; path: string }[];
  /** briefing.json location; its card text citations are the third channel. */
  briefingPath?: string;
  /** Deletion-snapshot file (under the varde data dir). Absent = no write,
   * deletions stay null (tests and the confidential pass never persist). */
  snapshotPath?: string;
  /** Link-degree history file (N4). Absent = no write, no deltas emitted. */
  degreeHistoryPath?: string;
  now?: number;
}

export async function collectMemoryGraph(
  hubRoot: string,
  confidentialSegments: Set<string>,
  opts?: CollectMemoryOpts,
): Promise<MemorySlice> {
  const includeConfidential = opts?.includeConfidential ?? false;
  const base = opts?.config ?? DEFAULT_MEMORY_CONFIG;
  const now = opts?.now ?? Date.now();

  // Confidential mode moves the confidential roots into the living tier for
  // the SEPARATE confidential projection; the public pass keeps them pruned.
  // Caveat (CHI-390 review): this lifts the bare declared segment names, and
  // patternMatches anchors from the hub root, so a top-level confidential tree
  // matches but a nested confidential subdir is under-included. That projection
  // is never wired in production today; revisit this if it is.
  const scope = includeConfidential
    ? {
        living: [...base.scope.living, ...confidentialSegments],
        historical: base.scope.historical,
        excluded: base.scope.excluded.filter((p) => !confidentialSegments.has(p)),
      }
    : base.scope;

  const files = walkMarkdownFiles(hubRoot, hubRoot, scope, includeConfidential, confidentialSegments);

  const nodes: MemGraphNode[] = [];
  const links: MemGraphLink[] = [];
  const deadLinks: DeadLink[] = [];
  const slugToId = new Map<string, string>();
  const pathToId = new Map<string, string>();
  const contentsById = new Map<string, string>();
  const statById = new Map<string, FileStat>();
  const skillNodes = new Map<string, MemGraphNode>();

  // records/decisions.jsonl holds every decision row (all history folded in,
  // CHI-313); each row explodes into a per-record node, and the file itself
  // never appears as a file node. records/sessions.jsonl is the session ledger.
  let decisionRows: DecisionRow[] = [];
  let decisionsRel = "records/decisions.jsonl";
  let sessionRows: SessionRow[] = [];
  let sessionsRel: string | null = null;

  const registerSlug = (slug: string, id: string): void => {
    if (!slugToId.has(slug)) slugToId.set(slug, id);
  };

  for (const file of files) {
    const rel = relative(hubRoot, file);
    if (!includeConfidential && pathIsConfidential(rel, confidentialSegments)) continue; // defense in depth
    const tier = tierFor(rel, scope);
    if (tier === "excluded") continue;

    // The structured record files explode into per-record nodes below
    // rather than appearing as one file node each.
    const seg = rel.split("/");
    if (seg[0] === "records" && seg.length === 2) {
      if (seg[1] === "decisions.jsonl") {
        try {
          decisionRows = parseDecisionsJsonl(readFileSync(file, "utf8"));
          decisionsRel = rel;
        } catch {
          /* unreadable: skip */
        }
        continue;
      }
      if (seg[1] === "sessions.jsonl") {
        try {
          sessionRows = parseSessionsJsonl(readFileSync(file, "utf8"));
          sessionsRel = rel;
        } catch {
          /* unreadable: skip */
        }
        continue;
      }
      // Old markdown ledgers are superseded by the jsonl during the bake
      // period; skip them so decisions and sessions are never double counted.
      if (seg[1] === "decisions.md" || seg[1].startsWith("sessions_index")) continue;
    }
    // Rotated decisions_history/*.md shards are folded into decisions.jsonl now.
    if (seg[0] === "records" && seg.length === 3 && seg[1] === "decisions_history") continue;

    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const stat = statOf(file);
    const filename = seg[seg.length - 1];
    const slug = filename.replace(/\.md$/, "");

    // A skill is one node (its SKILL.md is the living document); other md
    // files inside a skill dir fold into it rather than becoming noise.
    if (tier === "living" && seg[0] === "skills" && seg.length >= 3) {
      const skillName = seg[1];
      const id = `skill:${skillName}`;
      let node = skillNodes.get(skillName);
      if (!node) {
        node = {
          id,
          name: skillName,
          kind: "skill",
          tier,
          val: 3,
          color: KIND_COLOR.skill,
          path: `skills/${skillName}/SKILL.md`,
        };
        skillNodes.set(skillName, node);
        nodes.push(node);
        registerSlug(skillName, id);
        pathToId.set(`skills/${skillName}/SKILL.md`, id);
        contentsById.set(id, "");
      }
      if (filename === "SKILL.md" && stat) {
        statById.set(id, stat);
        node.mtime = new Date(stat.mtimeMs).toISOString();
      }
      pathToId.set(rel, id);
      contentsById.set(id, (contentsById.get(id) ?? "") + "\n" + content);
      continue;
    }

    const kind = kindFor(rel, tier);
    const id = rel.replace(/\.md$/, "");
    nodes.push({
      id,
      name: titleFor(content, filename),
      kind,
      tier,
      val: 4,
      color: KIND_COLOR[kind] ?? FALLBACK_COLOR,
      path: rel,
      mtime: stat ? new Date(stat.mtimeMs).toISOString() : undefined,
    });
    registerSlug(slug, id);
    registerSlug(id, id);
    pathToId.set(rel, id);
    contentsById.set(id, content);
    if (stat) statById.set(id, stat);
  }

  // Wikilinks between file-backed notes. Unresolved targets are DEAD LINKS,
  // named so the UI can list source -> target (Q24-Q26).
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const seenPairs = new Set<string>();
  const seenDead = new Set<string>();
  const pushDead = (source: string, sourcePath: string | undefined, target: string): void => {
    const key = `${source}::${target}`;
    if (seenDead.has(key)) return;
    seenDead.add(key);
    deadLinks.push({ source, sourcePath, target });
  };
  for (const [id, content] of contentsById) {
    for (const target of wikilinkTargets(content)) {
      const targetId = slugToId.get(target);
      if (targetId === id) continue;
      if (!targetId) {
        const src = nodeById.get(id);
        pushDead(src?.name ?? id, src?.path, target);
        continue;
      }
      const key = [id, targetId].sort().join("::");
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      links.push({ source: id, target: targetId, kind: "cross" });
    }
  }

  // Decision records: one node per decisions.jsonl row (all history folded in,
  // CHI-313). The row's title/body carry any wikilinks; the display label is
  // rebuilt from the structured date/title/session/stream fields.
  const wikilinkTouches: RawTouch[] = [];
  const seenDecisionIds = new Set<string>();
  for (const row of decisionRows) {
    const label = decisionLabel(row);
    const id = `decision:${label}`;
    if (seenDecisionIds.has(id)) continue;
    seenDecisionIds.add(id);
    const ms = row.date ? dateToMs(row.date) : Number.NaN;
    nodes.push({
      id,
      name: label,
      kind: "decision",
      tier: "historical",
      val: 3,
      color: KIND_COLOR.decision,
      path: decisionsRel,
      mtime: Number.isFinite(ms) ? new Date(ms).toISOString() : undefined,
    });
    for (const target of wikilinkTargets(`${row.title}\n${row.body}`)) {
      const targetId = slugToId.get(target);
      if (!targetId) {
        pushDead(label, decisionsRel, target);
        continue;
      }
      links.push({ source: id, target: targetId, kind: "decision" });
      if (Number.isFinite(ms)) wikilinkTouches.push({ ts: ms, noteId: targetId, channel: "wikilink" });
    }
  }

  // Session ledger rows; focus text links to the pages it names.
  if (sessionsRel) {
    for (const row of sessionRows) {
      const id = `session:${row.sessionId}`;
      const name = row.focus && row.focus !== "(pending)" ? row.focus : row.sessionId;
      const ms = dateToMs(row.date);
      nodes.push({
        id,
        name,
        kind: "session",
        tier: "historical",
        val: 2,
        color: KIND_COLOR.session,
        path: sessionsRel,
        mtime: Number.isFinite(ms) ? new Date(ms).toISOString() : undefined,
      });
      for (const target of wikilinkTargets(row.focus)) {
        const targetId = slugToId.get(target);
        if (!targetId) {
          pushDead(name, sessionsRel, target);
          continue;
        }
        links.push({ source: id, target: targetId, kind: "session" });
        if (Number.isFinite(ms)) wikilinkTouches.push({ ts: ms, noteId: targetId, channel: "wikilink" });
      }
    }
  }

  // Usage channel a: hub-file reads/edits from the spend scan's transcripts.
  const transcriptTouches: RawTouch[] = [];
  for (const touch of opts?.fileTouches ?? []) {
    const rel = relative(hubRoot, touch.path);
    if (rel.startsWith("..")) continue;
    const noteId = pathToId.get(rel);
    if (noteId) transcriptTouches.push({ ts: touch.ts, noteId, channel: "transcript" });
  }

  // Usage channel c: briefing-card citations (wikilinks or note paths named
  // in card text). Absent briefing.json contributes nothing, honestly.
  const briefingTouches: RawTouch[] = [];
  if (opts?.briefingPath) {
    try {
      const parsed = JSON.parse(readFileSync(opts.briefingPath, "utf8"));
      for (const card of Array.isArray(parsed?.cards) ? parsed.cards : []) {
        const at = new Date(card?.runAt ?? parsed?.generatedAt ?? "").getTime();
        if (!Number.isFinite(at)) continue;
        const text = [card?.title, card?.summary, card?.body].filter(Boolean).join("\n");
        const cited = new Set<string>();
        for (const target of wikilinkTargets(text)) {
          const noteId = slugToId.get(target);
          if (noteId) cited.add(noteId);
        }
        for (const [rel, noteId] of pathToId) {
          if (text.includes(rel)) cited.add(noteId);
        }
        for (const noteId of cited) briefingTouches.push({ ts: at, noteId, channel: "briefing" });
      }
    } catch {
      /* no briefing yet: the channel just reads zero */
    }
  }

  const noteMeta = new Map(
    nodes.map((n) => [n.id, { name: n.name, path: n.path, kind: n.kind, tier: n.tier }]),
  );
  const usage = mergeTouches([...transcriptTouches, ...wikilinkTouches, ...briefingTouches], noteMeta);

  // Rot: living only. "Unused" = no touch inside the flat threshold window
  // (per-kind thresholds only move the "old" test; the shipped override map
  // is empty, so this stays exact until someone tunes it).
  const living = nodes.filter((n) => n.tier === "living");
  const rotCutoff = now - base.rotDays * 86_400_000;
  const touchedIds = new Set<string>();
  for (const t of [...transcriptTouches, ...wikilinkTouches, ...briefingTouches]) {
    if (t.ts >= rotCutoff) touchedIds.add(t.noteId);
  }
  const linkedIds = new Set<string>();
  for (const link of links) {
    linkedIds.add(link.source);
    linkedIds.add(link.target);
  }
  const rot = computeRot(
    living.map((n) => ({
      id: n.id,
      name: n.name,
      path: n.path,
      kind: n.kind,
      mtimeMs: n.mtime ? new Date(n.mtime).getTime() : Number.NaN,
    })),
    { now, rotDays: base.rotDays, rotDaysByKind: base.rotDaysByKind, touchedIds, linkedIds },
  );

  // Growth: living births from APFS birthtimes; deletions accrue from
  // run-to-run snapshots when a snapshot path is provided.
  const births = living
    .map((n) => statById.get(n.id)?.birthtimeMs ?? Number.NaN)
    .filter((b) => Number.isFinite(b));
  const growthBase = computeGrowth(births, living.length, now);
  const livingPaths = living.map((n) => n.path).filter((p): p is string => !!p);
  const deletions = opts?.snapshotPath
    ? recordDeletions(opts.snapshotPath, livingPaths, new Date(now).toISOString().slice(0, 10))
    : null;
  const growth: GrowthRead = { ...growthBase, deletions };

  const connectivity = computeConnectivity(nodes, links, deadLinks);

  // Link-degree history (N4): changed-rows snapshot per scan, powering the
  // windowed connectivity deltas. Keyed by path, file-backed notes only
  // (decision/session records share their file's path and never rank).
  if (opts?.degreeHistoryPath) {
    const degree = new Map<string, number>();
    for (const link of links) {
      degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
      degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
    }
    const degreesByPath = new Map<string, number>();
    for (const n of nodes) {
      if (!n.path || n.kind === "decision" || n.kind === "session") continue;
      const deg = degree.get(n.id) ?? 0;
      if (deg > 0) degreesByPath.set(n.path, deg);
    }
    const today = new Date(now).toISOString().slice(0, 10);
    let history: DegreeHistoryFile | null = null;
    try {
      const parsed = JSON.parse(readFileSync(opts.degreeHistoryPath, "utf8"));
      if (parsed?.version === 1 && parsed.days) history = parsed as DegreeHistoryFile;
    } catch {
      // first run or unreadable: start fresh (deleting the file degrades honestly)
    }
    const next = appendDegreeDay(history, degreesByPath, today);
    writeFileSync(opts.degreeHistoryPath, JSON.stringify(next) + "\n");
    connectivity.degreeDeltas = computeDegreeDeltas(next, degreesByPath, today);
  }

  // Scope echo: per-folder counts from the measured corpus (Q19). Historical
  // wiki subdirs get their own row so "wiki" does not blur two tiers.
  const dirTally = new Map<string, { dir: string; tier: MemoryTier; notes: number }>();
  for (const n of nodes) {
    const seg = (n.path ?? "").split("/");
    const dir =
      n.kind === "decision" || n.kind === "session"
        ? "records"
        : seg.length <= 1
          ? "(root)"
          : seg[0] === "wiki" && n.tier === "historical"
            ? seg.slice(0, 2).join("/")
            : seg[0] === "records"
              ? seg.slice(0, Math.min(2, seg.length - 1)).join("/")
              : seg[0];
    const key = `${dir}\t${n.tier}`;
    const entry = dirTally.get(key) ?? { dir, tier: n.tier, notes: 0 };
    entry.notes++;
    dirTally.set(key, entry);
  }
  const dirs = [...dirTally.values()].sort(
    (a, b) => b.notes - a.notes || a.dir.localeCompare(b.dir),
  );

  const freshLiving = living.filter((n) => n.mtime && new Date(n.mtime).getTime() >= rotCutoff);
  const measurableLiving = living.filter((n) => n.mtime);

  return {
    stats: {
      totalFiles: nodes.length,
      totalWorkspaces: 0,
      stale: rot.oldCount,
      missing: 0,
      freshness: measurableLiving.length ? freshLiving.length / measurableLiving.length : 0,
      capSuggested: CAP_SUGGESTED,
      totalNotes: nodes.length,
      totalLinks: links.length,
      living: living.length,
      historical: nodes.length - living.length,
    },
    scope: {
      source: opts?.configSource ?? "defaults",
      configured: nodes.length > 0,
      tiers: {
        living: [...scope.living],
        historical: [...scope.historical],
        excluded: [...scope.excluded],
      },
      rotDays: base.rotDays,
      rotDaysByKind: base.rotDaysByKind,
      dirs,
    },
    rot,
    growth,
    usage,
    connectivity,
    nodes,
    links,
    noteDates: living
      .filter((n): n is MemGraphNode & { mtime: string } => n.mtime != null)
      .map((n) => ({ name: n.name, path: n.path, kind: n.kind, mtime: n.mtime })),
  };
}
