// The engine and route result shapes, declared once (#307, audit F10 + F23).
//
// Every one of these used to exist twice: once beside the engine that computes
// it and once, hand-retyped, in `src/api.ts` (or inside a component that called
// `fetch` itself). The comment that kept them in step said "mirrors
// server/<engine>.ts VERBATIM". They are declared here instead, and the engine
// and the client both import them, so a field added to a response reaches the
// client's type in the same commit.
//
// Rows (`sessions`/`messages` columns and the per-surface summaries) live next
// door in shared/rows.ts. Explore's wire contract, which speaks its own frozen
// token-cell dialect, lives in shared/explore.ts.
//
// Framework-free, like the rest of `shared/`: relative imports only.
import type { ParseTarget, Project, ScannedProject, ScannedSession, SourceId } from './types.ts';
import type { BucketedUsageCell, UsageByModel } from './usage.ts';
import type {
  Commit, DayCount, InsightsSessionRow, KindCount, MessageRow, ProjectErrorCount,
  ProjectSessionSummary, RepoInfo, SearchResultItem, SessionRow, ToolCount,
} from './rows.ts';

// ---- Scan / import (the import wizard) ----

export interface AnnotatedScannedSession extends ScannedSession {
  imported: boolean;
}
export interface AnnotatedScannedProject extends Omit<ScannedProject, 'sessions'> {
  imported: boolean;
  sessions?: AnnotatedScannedSession[];
}
/** The query GET /api/scan takes: one source, or a hand-typed directory. */
export interface ScanParams {
  source?: string;
  dir?: string;
}

/** GET /api/scan: importable projects per source. */
export type ScanResult = Partial<Record<SourceId | string, AnnotatedScannedProject[]>>;

/** What the client sends to POST /api/import: a subset of a scanned item, or a
 * hand-typed directory. That is exactly a `ParseTarget` (shared/types.ts) plus
 * the source that owns it — the same shape `Source.parse` takes, never a second
 * copy of it. Which of the target's fields a payload carries depends on the
 * source (a SQLite source has no log directory; a hand-typed import has no
 * scanned item), which is why they are all optional there. */
export interface ImportPayload extends ParseTarget {
  source: SourceId;
}
export interface ImportProjectAgg {
  id: number;
  name: string;
  path: string;
  created: boolean;
  sessions: number;
  messages: number;
}
export interface ImportResult {
  ok: true;
  imported: number;
  skippedSessions: number;
  totalMessages: number;
  projects: ImportProjectAgg[];
  projectId: number | null;
}
/** POST /api/projects/:id/sync. */
export interface SyncRunResult {
  ok: true;
  imported: number;
  skippedSessions: number;
  totalMessages: number;
  sources: string[];
}

// ---- Projects ----

/** One row of GET /api/projects. */
export interface ProjectListItem extends Project {
  session_count: number;
  message_count: number;
  last_active: string | null;
  sources: string | null;
  git: RepoInfo;
  /** Any session in the project has an open live watcher or ended in the last
   * 5 minutes (server/routes/projects.ts). */
  live: boolean;
}

/** The four scoped aggregates plus the ranged billed cells: the whole of what
 * the project page reports beyond its session list and its Git data. Computed
 * by the one Insights engine, scoped to the project (#305). */
export interface ScopedAggregates {
  toolDist: ToolCount[];
  kindDist: KindCount[];
  /** Message count per LOCAL calendar day, over the range. */
  activity: DayCount[];
  errors: number;
  rangedTokensByModel: BucketedUsageCell[];
}

/** GET /api/projects/:id. */
export interface ProjectDetailResult {
  project: Project;
  sessions: ProjectSessionSummary[];
  git: RepoInfo;
  analytics: ScopedAggregates & { commits: number };
}

// ---- Sessions ----

/** GET /api/sessions/:id/messages. */
export interface SessionMessagesResult {
  session: SessionRow;
  project: Project;
  messages: MessageRow[];
  commits: Commit[];
  git: RepoInfo;
  liveCandidate: boolean;
}
export interface RenameSessionResult {
  id: string;
  name: string | null;
  summary: string | null;
  first_prompt: string | null;
}
export interface SessionSyncResult {
  ok: true;
  imported: number;
  totalMessages: number;
}
export interface DeleteSessionResult {
  ok: true;
  source: string;
  projectId: number;
}
/** GET /api/sessions/:id/resolve — which project a bare session id belongs to. */
export interface ResolveSessionResult {
  id: string;
  project_id: number;
}

// ---- Search ----

export interface SearchParams {
  q?: string;
  scope?: string;
  days?: string | number;
  project?: string | number;
  /** Empty-query "recent" branch only: page offset for the Home ledger's
   * lazy scroll (the server returns 50 per page). */
  offset?: number;
}
export interface SearchResponse {
  recent: boolean;
  results: SearchResultItem[];
}

// ---- Settings ----

/** GET / PATCH /api/settings. The stored config (server/config.ts) is wider and
 * partial; this is the resolved view every surface reads. */
export interface Settings {
  autoSync: boolean;
  autoSyncPaused: boolean;
  ask: boolean;
  minorActiveMsThreshold: number;
  minorMessageCountThreshold: number;
  planWindows: boolean;
  /** Monthly spend budget in USD, or null when unset. */
  monthlyBudget: number | null;
}
export type SettingsPatch = Partial<Settings>;

/** GET /api/autosync/status. */
export interface AutosyncStatus {
  enabled: boolean;
  running: boolean;
  lastRun: string | null;
  lastResult:
    | { ok: true; imported: number; checked: number; ms: number }
    | { ok: true; skipped: string }
    | { ok: false; error: string }
    | null;
  /** When the first change that has not been synced yet was seen (epoch ms),
   * or null when nothing is pending — the max-wait timer reads it. */
  firstPendingAt: number | null;
}

// ---- Plan windows (the one outbound read, opt-out) ----

export interface AccountWindow { label: string; utilization: number; resetsAt: string | null }
export interface PlanAccount { name: string; kind: 'claude' | 'codex'; plan: string | null; windows: AccountWindow[] }
export interface PlanWindowsResult {
  /** Claude toggle state (default ON). False means we never went outbound. */
  claudeEnabled: boolean;
  /** true when the Claude toggle is on but no readable credential was found. */
  claudeUnauthed: boolean;
  accounts: PlanAccount[];
}

// ---- Ask (the local claude-CLI-backed metric chat) ----

export interface AskStatus {
  /** toggleOn && claudePresent && !demo */
  enabled: boolean;
  toggleOn: boolean;
  claudePresent: boolean;
  demo: boolean;
}
/** The cost basis the operator picked, in the words /ask shows.
 * server/ask.ts maps it onto the price core's own spelling. */
export type AskCostMode = 'list' | 'billed';
/** One persisted /ask turn: what the runner prints, what the route appends to
 * the turn log, and what AskPage renders. */
export interface AskTurn {
  id: string;
  /** ISO timestamp. */
  ts: string;
  question: string;
  costBasis: AskCostMode;
  ok: boolean;
  prose: string;
  sql: string | null;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  note?: string;
  /** Set when `ok === false`. */
  error?: string;
}

// ---- Insights ----

export interface InsightsResult {
  sessions: InsightsSessionRow[];
  toolDist: ToolCount[];
  kindDist: KindCount[];
  modelDist: { model: string; count: number }[];
  /** Fixed 30-day-trailing model distribution — the same fixed span as
   * `hourlyActivity`, NOT the `days=` cutoff, so Working Rhythm's "Favorite
   * model" stays in step with its fixed-range card-mates. */
  modelDistFixed: { model: string; count: number }[];
  errors: number;
  errorsByProject: ProjectErrorCount[];
  commits: number;
  dailyActivity: DayCount[];
  hourlyActivity: { dow: number; hour: number; count: number }[];
  projects: { id: number; name: string }[];
  /** Per-session, per-model, per-LOCAL-day, in-range-scaled billed cells: the
   * client prices these instead of summing raw `sessions.usage`, so a session
   * that started before the range but ran INTO it contributes its in-range
   * share, and one straddling a rate change prices each day at that day's rate. */
  rangedTokensByModel: BucketedUsageCell[];
  /** The same cells, bucketed by LOCAL calendar day, for spend-over-time. */
  dailySpend: BucketedUsageCell[];
  /** The same, bucketed by LOCAL hour-of-day — only meaningful (and only
   * computed) for a short range, so it is null unless days<=2; the client falls
   * back to `dailySpend`. */
  hourlySpend: BucketedUsageCell[] | null;
}

// ---- Home activity feed ----
// Every token figure is a per-model CELL; the client prices it via models.ts
// costOf (the price table stays client-side — a hard constraint).

export interface ActivitySessionLite {
  id: string;
  /** Resolved display name (name → summary → first_prompt → id). */
  name: string;
  projectName: string;
  source: string;
  live: boolean;
  endedAt: string | null;
  tokensByModel: UsageByModel;
  errorCount: number;
}
/** One day's per-dimension token cells (dollars are priced client-side).
 * `byProject` is keyed by NAME, for display. */
export interface AnomalyDayCells {
  day: string;
  byModel: UsageByModel;
  byProject: Record<string, UsageByModel>;
  bySource: Record<string, UsageByModel>;
}
export interface ActivityBurn {
  rangeSpendTokensByModel: UsageByModel;
  /** Day-bucketed breakdown of `rangeSpendTokensByModel` — see
   * server/activity.ts for why only this field is day-bucketed. */
  rangeSpendTokensByModelByDay: Record<string, UsageByModel>;
  baselineTokensByModel: UsageByModel;
  topSessionId: string | null;
  topSessionName: string | null;
  topSessionTokensByModel: UsageByModel;
  /** Per-day per-dimension cells for the anomaly tile (the client prices them
   * → CostedDay[] → shared computeAnomaly). */
  anomalyDays: AnomalyDayCells[];
  /** LOCAL "today" key (YYYY-MM-DD), the anchor computeAnomaly compares against. */
  today: string;
}
export interface ActivityResult {
  live: ActivitySessionLite[];
  recent: ActivitySessionLite[];
  burn: ActivityBurn;
}

// ---- Content ----

/** How to read a characteristic's `value` (and its optional secondary
 * `value2`, always a percent). */
export type CharacteristicFormat = 'percent' | 'tokens' | 'hours';

/** One Content characteristic. Every field the client needs to RENDER the row
 * travels on the characteristic itself — the client maps over the array
 * generically, it never switches on `key`. */
export interface Characteristic {
  key: string;
  /** Bold lead-in text, after the formatted value. */
  label: string;
  /** One-line plain-language explainer. */
  why: string;
  /** Full-sentence InfoTip copy. */
  info: string;
  format: CharacteristicFormat;
  /** The leading number, read per `format`. */
  value: number;
  /** Secondary percent value, e.g. peakContextTokens' "% of window". */
  value2?: number;
  warn?: boolean;
  /** Qualifying session/run/turn count, when meaningful. */
  count?: number;
  countOne?: string;
  countMany?: string;
  exact: boolean;
  /** Short phrase naming WHICH population this row's number is over — the
   * DEDUP cue (#206), rendered as its own chip beside the row. Distinct
   * across every row of a scope's set, so two same-family rows (the two
   * context-pressure shares, the two subagent shares) can never read as one
   * restated stat. */
  measure: string;
  /** Set when this row's population is a strict SUBSET of another row's in the
   * same set (#206): that row's `key`, this row's share OF it (`percent`, a
   * separately computed ratio, never a restatement of `value`) and the prose
   * the client renders after it. Omitted when the parent measures zero, since
   * there is then no share to state. */
  subsetOf?: { key: string; percent: number; phrase: string };
}

export interface ContentResult {
  /** By kind, calibrated. */
  composition: { key: string; tokens: number }[];
  toolResultsByTool: { key: string; tokens: number }[];
  /** count exact, tokens calibrated. */
  skills: { key: string; count: number; tokens: number }[];
  /** Both exact. */
  subagents: { key: string; runs: number; tokens: number }[];
  /** At 'all'/'project' scope: the 7 token-share characteristics. At 'session'
   * scope the threshold predicates that collapse to 0%/100% at N=1 are replaced
   * by absolute session facts (server/content.ts). */
  characteristicsScope: 'all' | 'project' | 'session';
  characteristics: Characteristic[];
  calibratedTotalTokens: number;
  /** composition, toolResultsByTool and skills[].tokens are calibrated
   * (text-length → billed); subagents[].tokens are exact. */
  calibrated: boolean;
}

// ---- Efficiency: detectors and waste ----

/** GET /api/detectors — COUNTS, never graded words or dollars. The client
 * derives and grades the four rates with the shared thresholds. */
export interface DetectorCounts {
  /** Assistant messages carrying a model in range — the denominator for the
   * jumbo and long-context shares. */
  assistantRows: number;
  /** Assistant messages whose output exceeded the jumbo threshold. */
  jumboRows: number;
  /** Assistant messages whose fed-in context exceeded the long-context threshold. */
  longContextRows: number;
  /** Token sums for the cache-hit rate = cacheRead / (cacheRead + input). */
  cacheReadTokens: number;
  inputTokens: number;
}

export interface ModelCacheCells { cw5m: number; cw1h: number }
export interface ChurnSession {
  session: string; project: string;
  writeTokens: number; readTokens: number;
  /** For the premium-$ pricing, client-side. */
  byModel: Record<string, ModelCacheCells>;
}
export interface RightSizingModel {
  model: string; messages: number;
  input: number; output: number; cacheRead: number; cw5m: number; cw1h: number;
}
export interface RereadFile { path: string; rereads: number; sessions: number }
/** GET /api/waste — token cells + counts; the client prices the premium,
 * savings and wasted dollars. */
export interface WasteResult {
  cacheChurn: { sessionsFlagged: number; top: ChurnSession[] };
  /** Small-turn messages; the client filters premium models and reprices. */
  rightSizing: { candidates: RightSizingModel[] };
  rereads: { rereadCalls: number; sessionsAffected: number; estWastedTokens: number; topFiles: RereadFile[] };
}

// ---- Git (time travel) ----

export type GitAtResult = { commit: Commit | null } | { noRepo: true };
export type GitTreeResult = { files: string[]; changed: string[] } | { noRepo: true };
export type GitFileResult =
  | { content: string | null; previous: string | null; prevCommit: string | null; changedInCommit: boolean }
  | { noRepo: true };

// ---- Security check (redaction preview) ----

/** One pattern match inside a scanned message, with the rule that made it and
 * what that rule would put in its place. `field` says which of the message's
 * two scanned strings it was found in. */
export interface SecurityFinding {
  rule: string;
  ruleName: string;
  match: string;
  start: number;
  end: number;
  replacement: string;
  field: 'text' | 'tool_input';
}

/** One scanned message: the original strings beside their redacted twins, so
 * the preview can highlight what would change. */
export interface SecurityCheckMessage {
  seq: number;
  kind: string;
  ts?: string | null;
  tool_name?: string | null;
  findings: SecurityFinding[];
  redactedText: string | null | undefined;
  redactedInput: string | null | undefined;
  originalText: string | null | undefined;
  originalInput: string | null | undefined;
}

/** GET /api/sessions/:id/security-check. `totals` is findings per rule name. */
export interface SecurityScanResult {
  messages: SecurityCheckMessage[];
  totals: Record<string, number>;
  findingCount: number;
}

// ---- Live ----

/** GET /api/live/status — the open live watchers, so a surface can tell "a
 * session here is live" from state another tab opened. */
export interface LiveWatcher {
  sessionId: string;
  file?: string;
  clients: number;
  offset?: number;
}
