import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { Event, ModelUsage, ParseResult, ScannedProject, ScannedSession } from '../../shared/types.ts';
import { isSyntheticUserText } from '../../shared/synthetic.ts';

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface HeadSniff {
  cwd: string | null;
  summary: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw JSONL line shapes (Claude Code transcript format — external, untyped by
// upstream). Fields are optional/loosely typed on purpose: the parser is
// defensive against missing/malformed data by design (see try/catch below).

interface ClaudeContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  name?: string;
  id?: string;
  input?: unknown;
}

interface ClaudeCacheCreation {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: ClaudeCacheCreation;
}

interface ClaudeMessage {
  role?: string;
  model?: string;
  content?: string | ClaudeContentBlock[];
  usage?: ClaudeUsage;
  // Anthropic's per-API-call message id (`msg_...`). Present on every assistant
  // line current Claude Code writes (100% of 9,952 usage lines audited).
  id?: string;
}

interface ClaudeLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  isSidechain?: boolean;
  parentUuid?: string;
  message?: ClaudeMessage;
  customTitle?: string;
  summary?: string;
  // Per-agent id Claude Code stamps on inline sidechain lines (matches the
  // hex id in a subagent file's own name, agent-<hex>.jsonl, when that agent
  // was ALSO written to its own file).
  agentId?: string;
  // Anthropic's per-API-request id (`req_...`), the second half of the call
  // dedup key. Absent on a handful of lines (3 of ~10k audited), which is why
  // the key tolerates either half being missing.
  requestId?: string;
}

// Sidecar written next to a subagent transcript file (agent-<hex>.meta.json).
// agentType (fallback attribution) and description (surfaced in the run list —
// see the Subagents drill-in) are consumed; toolUseId/spawnDepth are read but
// not yet surfaced.
interface AgentMeta {
  agentType?: string;
  description?: string;
}

// Scan ~/.claude/projects for importable projects with session/message estimates.
export function scanClaudeProjects(baseDir: string = CLAUDE_PROJECTS_DIR): ScannedProject[] {
  if (!fs.existsSync(baseDir)) return [];
  const results: ScannedProject[] = [];
  for (const dirent of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const logDir = path.join(baseDir, dirent.name);
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) continue;
    let messageEstimate = 0;
    let physicalPath: string | null = null;
    const sessions: ScannedSession[] = [];
    for (const f of files) {
      const full = path.join(logDir, f);
      const stat = fs.statSync(full);
      const est = Math.max(1, Math.round(stat.size / 2000));
      messageEstimate += est;
      const head = sniffHead(full);
      if (!physicalPath && head.cwd) physicalPath = head.cwd;
      const mtimeMs = claudeSessionMtimeMs(full) ?? stat.mtime.getTime();
      sessions.push({
        id: path.basename(f, '.jsonl'),
        file: full,
        label: head.summary,
        modifiedAt: new Date(mtimeMs).toISOString(),
        messageEstimate: est,
      });
    }
    sessions.sort((a, b) => ((a.modifiedAt ?? '') < (b.modifiedAt ?? '') ? 1 : -1));
    results.push({
      source: 'claude-code',
      logDir,
      name: physicalPath ? path.basename(physicalPath) : dirent.name,
      physicalPath,
      sessionCount: files.length,
      messageEstimate,
      sessions,
    });
  }
  return results.sort((a, b) => b.sessionCount - a.sessionCount);
}

// Read the first and last few KB of a JSONL file to find the project's real cwd
// and a human label (the "summary" line Claude Code prepends to session logs).
// The cwd comes from the TAIL: sessions resumed after a repo move keep the old
// path in their early records, and the latest cwd is where the project (and its
// Git history) lives now. Falls back to the head when the tail has no cwd.
function sniffHead(file: string): HeadSniff {
  const head: HeadSniff = { cwd: null, summary: null };
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const headText = buf.toString('utf8', 0, n);
    let tailText = '';
    if (size > n) {
      const tn = fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
      tailText = buf.toString('utf8', 0, tn);
    }
    fs.closeSync(fd);
    for (const line of headText.split('\n')) {
      if (!head.cwd) {
        const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
        if (m) try { head.cwd = JSON.parse(`"${m[1]}"`); } catch {}
      }
      if (!head.summary) {
        const s = line.match(/^\{"type":"summary","summary":"((?:[^"\\]|\\.)*)"/);
        if (s) try { head.summary = JSON.parse(`"${s[1]}"`).slice(0, 120); } catch {}
      }
      if (head.cwd && head.summary) break;
    }
    const tailCwds: string[] = [];
    for (const m of tailText.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
      try { tailCwds.push(JSON.parse(`"${m[1]}"`)); } catch {}
    }
    if (tailCwds.length) head.cwd = reduceCwd(tailCwds[tailCwds.length - 1], new Set(tailCwds.concat(head.cwd || [])));
  } catch {}
  return head;
}

// A session can record subdirectory cwds (e.g. <repo>/server). Walk the pick up
// to the shortest seen ancestor so grouping lands on the project root.

// Strip a superpowers git-worktree segment (<repo>/.claude/worktrees/<name>[/...])
// down to the parent repo root, so worktree-origin sessions map to the parent
// project instead of an ephemeral, unregistered worktree path (autosync skips
// any cwd that isn't a known project — server/autosync.ts). Detection is scoped
// to the .claude/worktrees/ convention only; a deleted worktree leaves no
// filesystem git-metadata, so a path heuristic is the only thing that works.
// Design: records/brainstorms/2026-08-14-worktree-cwd-collapse-design.md
export function collapseWorktree(p: string): string {
  return p ? p.replace(/\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/, '') : p;
}

export function reduceCwd(pick: string, seen: Set<string>): string {
  let out = collapseWorktree(pick);
  for (const c of seen) {
    const cc = collapseWorktree(c);
    if (cc && cc !== out && out.startsWith(cc + '/')) out = cc;
  }
  return out;
}

// A Claude Code session's effective source mtime for freshness checks — the
// newer of the main file and every file under its subagents tree (direct
// agent-*.jsonl/.meta.json plus subagents/workflows/wf_*/agent-*.jsonl), so a
// new or updated subagent transcript triggers re-sync even when the main file
// itself hasn't changed. Used by scanClaudeProjects' `modifiedAt` above and by
// server/autosync.ts's incremental-sync mtime pre-filter. Returns null only
// when the main file itself can't be stat'd (the caller falls back).
export function claudeSessionMtimeMs(file: string): number | null {
  let m: number;
  try { m = fs.statSync(file).mtime.getTime(); } catch { return null; }
  const subagentsDir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  return Math.max(m, maxMtimeRecursive(subagentsDir));
}

function maxMtimeRecursive(dir: string): number {
  let m = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      m = Math.max(m, maxMtimeRecursive(full));
    } else {
      try { m = Math.max(m, fs.statSync(full).mtime.getTime()); } catch {}
    }
  }
  return m;
}

// One subagent transcript file to ingest, with its workflow attribution
// (null for a direct subagents/agent-*.jsonl file; the `wf_*` folder name for
// one nested under subagents/workflows/wf_*/agent-*.jsonl). Sorted by full
// path for deterministic ingestion order.
interface AgentFileRef {
  file: string;
  workflowId: string | null;
}

function listAgentFiles(subagentsDir: string): AgentFileRef[] {
  const out: AgentFileRef[] = [];
  if (!fs.existsSync(subagentsDir)) return out;
  for (const f of fs.readdirSync(subagentsDir)) {
    if (f.endsWith('.jsonl') && f.startsWith('agent-')) {
      out.push({ file: path.join(subagentsDir, f), workflowId: null });
    }
  }
  const workflowsDir = path.join(subagentsDir, 'workflows');
  try {
    for (const wf of fs.readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!wf.isDirectory()) continue;
      const wfDir = path.join(workflowsDir, wf.name);
      for (const f of fs.readdirSync(wfDir)) {
        if (f.endsWith('.jsonl') && f.startsWith('agent-')) {
          out.push({ file: path.join(wfDir, f), workflowId: wf.name });
        }
      }
    }
  } catch {}
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}

// Best-effort read of a subagent's agent-<hex>.meta.json sidecar. Missing or
// malformed sidecars are treated as absent — meta.agentType is only a
// fallback, never required.
function readAgentMeta(agentFile: string): AgentMeta | null {
  try {
    const raw = fs.readFileSync(agentFile.replace(/\.jsonl$/, '.meta.json'), 'utf8');
    return JSON.parse(raw) as AgentMeta;
  } catch {
    return null;
  }
}

// The per-run identifier for a subagent transcript file: the hex id in
// agent-<hex>.jsonl. This is the run-level key the Overview Subagents card
// header counts (distinct agent_id), as opposed to agent_type which only
// distinguishes the KIND of subagent, not each individual run.
function agentIdFromFile(agentFile: string): string | null {
  const m = path.basename(agentFile).match(/^agent-(.+)\.jsonl$/);
  return m ? m[1] : null;
}

// Parse a single JSONL entry into normalized events (shared by import + live tail).
export function parseClaudeLine(o: ClaudeLine): Event[] {
  const events: Event[] = [];
  if (o.type === 'user' && o.message) {
    const content = o.message.content;
    if (typeof content === 'string') {
      if (content.startsWith('<command-name>') || content.startsWith('<local-command')) return events;
      events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'user', text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'tool_result',
            text: blockText(block.content), tool_use_id: block.tool_use_id });
        } else if (block.type === 'text' && block.text?.trim() && !block.text.startsWith('<system-reminder>')) {
          events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'user', text: block.text });
        }
      }
    }
  } else if (o.type === 'assistant' && o.message) {
    const model = o.message.model;
    for (const block of o.message.content as ClaudeContentBlock[] || []) {
      if (block.type === 'text' && block.text?.trim()) {
        events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'assistant', text: block.text, model });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'thinking', text: block.thinking, model });
      } else if (block.type === 'tool_use') {
        events.push({ uuid: o.uuid, ts: o.timestamp, kind: 'tool_use', model,
          tool_name: block.name, tool_use_id: block.id, tool_input: safeStringify(block.input) });
      }
    }
    // Anthropic's per-call identity on EVERY event of the line, usage-bearing
    // or not — `uuid` is per-line, so this pair is the only thing a
    // later pass over `messages` can dedup on.
    for (const e of events) {
      e.message_id = o.message.id ?? null;
      e.request_id = o.requestId ?? null;
    }
  }
  if (o.isSidechain) for (const e of events) e.is_sidechain = 1;
  return events;
}

function newUsageAgg(): ModelUsage {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

// One raw `message.usage` block normalized into billed cells. 5-minute and
// 1-hour cache writes are billed at different rates, so they stay split; a log
// that reports an unsplit `cache_creation_input_tokens` was billed at the 5m
// rate, so it lands in that tier.
function usageCells(u: ClaudeUsage): ModelUsage {
  const cc = u.cache_creation;
  const split = !!cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null);
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite5m: split ? (cc.ephemeral_5m_input_tokens || 0) : (u.cache_creation_input_tokens || 0),
    cacheWrite1h: split ? (cc.ephemeral_1h_input_tokens || 0) : 0,
    cacheRead: u.cache_read_input_tokens || 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-API-call registry
//
// Claude Code splits ONE API response's content blocks across several
// transcript lines (an empty `thinking` block, then text, then tool_use), and
// EVERY one of those lines repeats the full `message.usage`. Summing per line
// billed one call two or three times — measured 2.20-2.44x against transcript
// truth, and 1.67-2.04x against Anthropic's own reported usage.
// `uuid` is per-LINE and cannot collapse them.
// The only stable per-CALL key is `(message.id, requestId)`: the only pair the
// transcript repeats verbatim across a replay.
//
// ATTRIBUTION, and this is the dominant path rather than an edge case: 58.8% of
// calls OPEN with a `{"type":"thinking","thinking":""}` line that
// parseClaudeLine drops entirely, and 25.2% of all token mass sits on such
// event-less lines. So a call's cells are held here and attached to the FIRST
// EVENT-PRODUCING line of that call, whichever line that turns out to be —
// never blindly to the first line. Later lines of the same call merge into the
// slot and rewrite the already-attached event in place, attaching nothing of
// their own. Net effect: each call is billed exactly once, and
// SUM(messages token columns) == sessions.usage.
interface CallSlot {
  model: string;
  cells: ModelUsage;
  event: Event | null;
}

interface CallRegistry {
  slots: Map<string, CallSlot>;
  anon: number;
}

function newCallRegistry(): CallRegistry {
  return { slots: new Map(), anon: 0 };
}

// A sidechain event that still carries its run's identity. Used only to break a
// cross-file tie — see claimCall.
function hasRunIdentity(e: Event): boolean {
  return e.is_sidechain === 1 && (e.agent_id != null || e.workflow_id != null);
}

function stampEventUsage(e: Event, c: ModelUsage): void {
  e.input_tokens = c.input;
  e.output_tokens = c.output;
  e.cache_read_tokens = c.cacheRead;
  e.cache_w5m_tokens = c.cacheWrite5m;
  e.cache_w1h_tokens = c.cacheWrite1h;
}

function clearEventUsage(e: Event): void {
  e.input_tokens = null;
  e.output_tokens = null;
  e.cache_read_tokens = null;
  e.cache_w5m_tokens = null;
  e.cache_w1h_tokens = null;
}

// Record one assistant line's usage under its call key. Returns the key so the
// line's first event can claim the slot.
function recordCall(reg: CallRegistry, o: ClaudeLine, u: ClaudeUsage): string {
  const msgId = o.message?.id;
  // A line carrying NEITHER id can never be PROVEN a replay, so it gets a
  // private key and is billed on its own, rather than collapsed into whatever
  // unkeyed line came before it.
  const key = (msgId || o.requestId) ? `${msgId ?? ''}:${o.requestId ?? ''}` : `\u0000anon:${reg.anon++}`;
  const cells = usageCells(u);
  const slot = reg.slots.get(key);
  if (!slot) {
    reg.slots.set(key, { model: o.message?.model || 'unknown', cells, event: null });
    return key;
  }
  // Keep-max PER CELL: a replayed line can be truncated, so the largest value
  // seen for each cell is the real one. Swapping the whole record when its
  // total is larger agrees exactly across all 3,132 duplicate keys on disk
  // (cell-wise max never once exceeded record max), so this stays reconcilable
  // while additionally surviving a partial replay.
  slot.cells = {
    input: Math.max(slot.cells.input, cells.input),
    output: Math.max(slot.cells.output, cells.output),
    cacheWrite5m: Math.max(slot.cells.cacheWrite5m, cells.cacheWrite5m),
    cacheWrite1h: Math.max(slot.cells.cacheWrite1h, cells.cacheWrite1h),
    cacheRead: Math.max(slot.cells.cacheRead, cells.cacheRead),
  };
  if (slot.event) stampEventUsage(slot.event, slot.cells);
  return key;
}

// The first event-producing line of a call takes ownership of its token columns.
function claimCall(reg: CallRegistry, key: string, e: Event): void {
  const slot = reg.slots.get(key);
  if (!slot) return;
  if (!slot.event) {
    slot.event = e;
    stampEventUsage(e, slot.cells);
    return;
  }
  // Cross-file tie-break. The registry is session-scoped and shared by the main
  // file and the subagents/agent-*.jsonl loop, because `mainUuids` dedups by
  // UUID and so cannot catch the same call written to both files with different
  // uuids. No such key exists on disk today, so this is insurance — but if one
  // appears, the tokens must sit on the row that still carries the run's
  // identity, or server/content.ts's workflowRuns/subagentTurns token shares
  // under-count against a denominator that still includes them.
  if (!hasRunIdentity(slot.event) && hasRunIdentity(e)) {
    clearEventUsage(slot.event);
    slot.event = e;
    stampEventUsage(e, slot.cells);
  }
}

// Fold the registry into per-model session totals.
//
// A call whose EVERY line was event-less still bills here, even though no
// message row exists to carry its cells. That is deliberate: losing real spend
// is strictly worse than breaking SUM(messages) == sessions.usage for that call.
// Measured over 420 exactly-reimported sessions, it affects 13 of them and
// 0.0286% of billed tokens — always a call whose only content was an empty
// `thinking` block. So the invariant is "SUM(messages) <= sessions.usage, equal
// except for content-less calls", not a strict equality.
function foldCallsByModel(reg: CallRegistry): Map<string, ModelUsage> {
  const byModel = new Map<string, ModelUsage>();
  for (const slot of reg.slots.values()) {
    const agg = byModel.get(slot.model) || newUsageAgg();
    agg.input += slot.cells.input;
    agg.output += slot.cells.output;
    agg.cacheWrite5m += slot.cells.cacheWrite5m;
    agg.cacheWrite1h += slot.cells.cacheWrite1h;
    agg.cacheRead += slot.cells.cacheRead;
    byModel.set(slot.model, agg);
  }
  return byModel;
}

// Parse one session JSONL file into { session, events }.
export async function parseClaudeSession(file: string): Promise<ParseResult> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const events: Event[] = [];
  let sessionId = path.basename(file, '.jsonl');
  let cwd: string | null = null;
  const cwdsSeen = new Set<string>();
  let firstPrompt: string | null = null;
  let summary: string | null = null;
  let customTitle: string | null = null;
  let skipped = 0;
  let contextTokens: number | null = null;
  // Session-scoped, and deliberately SHARED with the subagent-file loop below —
  // see claimCall's cross-file tie-break.
  const calls = newCallRegistry();
  const taskPromptType = new Map<string, string>(); // Task prompt head → subagent_type (sidechain pairing)
  const uuidAgentType = new Map<string, string | null>();  // sidechain uuid → agent_type (parent-chain propagation)
  let pendingCommandSkill: string | null = null;   // set by a <command-name> turn, consumed by the next assistant event
  const mainUuids = new Set<string>(); // every uuid seen in the main file, for dedup against subagent-folder files

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: ClaudeLine;
    try { o = JSON.parse(line); } catch { skipped++; continue; }
    if (o.uuid) mainUuids.add(o.uuid);
    if (o.sessionId) sessionId = o.sessionId;
    // Claude Code stores a user rename as `{"type":"custom-title","customTitle":"…"}`
    // (the /rename-session title). The LAST one wins — a session can be renamed
    // repeatedly. This is the authoritative default name shown in Chronicle.
    if (o.type === 'custom-title' && typeof o.customTitle === 'string' && o.customTitle.trim()) {
      customTitle = o.customTitle.slice(0, 200);
    }
    // Older logs may carry a `{"type":"summary","summary":"…"}` title; keep the first
    // as a fallback when no explicit custom title exists.
    if (!summary && o.type === 'summary' && typeof o.summary === 'string' && o.summary.trim()) {
      summary = o.summary.slice(0, 200);
    }
    // Latest cwd wins: sessions resumed after a repo move carry the old path in
    // their early records; the newest cwd is where the project lives now.
    if (o.cwd) { cwd = o.cwd; cwdsSeen.add(o.cwd); }
    // Real context-window size: the prompt side of the LAST main-chain API call
    // (matches Claude Code's own status line; sidechains are separate contexts).
    // Same pass aggregates per-model token usage for the Cost & Usage panel —
    // sidechain usage INCLUDED (v0.2: it's real spend; context_tokens stays
    // main-chain only).
    // `callKey` carries this line's API-call identity down to the event loop
    // below, where the line's first event claims the call's token columns.
    let callKey: string | null = null;
    if (o.type === 'assistant' && o.message?.usage) {
      const u = o.message.usage;
      if (!o.isSidechain) {
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (ctx > 0) contextTokens = ctx;
      }
      callKey = recordCall(calls, o, u);
    }
    // Skill context: a Skill tool_use row carries its own skill name; a
    // `/command` turn tags the first assistant event that follows it
    // (per-invocation marker only — no span attribution, by design).
    if (o.type === 'user' && typeof o.message?.content === 'string') {
      const cm = o.message.content.match(/^<command-name>\/?([^<]+)<\/command-name>/);
      if (cm) pendingCommandSkill = cm[1].trim().slice(0, 100) || null;
    }
    const lineEvents = parseClaudeLine(o);
    // Sidechain agent_type: pair the sidechain's first user message with the
    // main chain's Task/Agent tool_use input (subagent_type + prompt), then
    // propagate along the parentUuid chain.
    if (o.isSidechain) {
      let at: string | null | undefined = o.parentUuid ? uuidAgentType.get(o.parentUuid) : undefined;
      if (at === undefined && o.type === 'user') {
        const content = o.message?.content;
        const txt = typeof content === 'string' ? content
          : Array.isArray(content) ? content.find((b) => b.type === 'text')?.text : undefined;
        if (txt) at = taskPromptType.get(txt.slice(0, 300)) ?? null;
      }
      uuidAgentType.set(o.uuid as string, at ?? null);
      if (at) for (const e of lineEvents) e.agent_type = at;
      // Run-level id: stamp straight from the line's own `agentId` field when
      // present (no propagation needed — Claude Code writes it on every line
      // of a given run). Left null when absent (older logs).
      if (o.agentId) for (const e of lineEvents) e.agent_id = o.agentId;
    }
    let claimed = false;
    for (const e of lineEvents) {
      if (e.kind === 'tool_use') {
        if (e.tool_name === 'Task' || e.tool_name === 'Agent') {
          try {
            const inp = JSON.parse(e.tool_input || '{}');
            if (inp.subagent_type && inp.prompt) taskPromptType.set(String(inp.prompt).slice(0, 300), inp.subagent_type);
          } catch {}
        }
        if (e.tool_name === 'Skill') {
          try { e.skill = JSON.parse(e.tool_input || '{}').skill || null; } catch {}
        }
      }
      // One API call = one set of numbers, on the first event this call
      // produces anywhere in the session (others NULL). A line that repeats an
      // already-claimed call attaches nothing — that is the fix.
      if (callKey && !claimed) {
        claimCall(calls, callKey, e);
        claimed = true;
      }
      if (pendingCommandSkill && !o.isSidechain && (e.kind === 'assistant' || e.kind === 'thinking' || e.kind === 'tool_use')) {
        if (!e.skill) e.skill = pendingCommandSkill;
        pendingCommandSkill = null;
      }
      events.push(e);
      // first_prompt is the session's DISPLAY-NAME fallback: skip
      // synthetic user rows (command echoes, system reminders, cross-session IPC)
      // so the name is a real human prompt, never a raw `<…>` wrapper.
      if (e.kind === 'user' && !e.is_sidechain && !firstPrompt && !isSyntheticUserText(e.text)) firstPrompt = (e.text ?? '').slice(0, 200);
    }
  }

  // Sidechains: current Claude Code writes subagent transcripts to separate
  // files rather than inline isSidechain lines —
  //   <logDir>/<sessionId>/subagents/agent-*.jsonl                       (direct)
  //   <logDir>/<sessionId>/subagents/workflows/wf_*/agent-*.jsonl        (workflow)
  // Import them as sidechain rows: usage aggregates into the session totals
  // (real spend), context_tokens stays main-chain. Each event's agent_type is
  // resolved by (1) pairing the subagent's first user message against the main
  // chain's Task/Agent tool_use prompt, falling back to (2) the sibling
  // agent-*.meta.json's `agentType` (workflow agents are spawned by
  // orchestration, not a matching inline Task call, so they rely on the
  // meta.json fallback). `workflow_id` is the `wf_*` folder name, or null for a
  // direct agent. Lines whose uuid already appeared in the main file are
  // skipped (some Claude Code versions duplicate an inline sidechain entry
  // into its own agent file). Sidechain events are appended after the main
  // chain, each agent's block internally ts-ordered (UI excludes them by
  // default; consumers order by ts).
  const subagentsDir = path.join(path.dirname(file), sessionId, 'subagents');
  for (const ref of listAgentFiles(subagentsDir)) {
    const meta = readAgentMeta(ref.file);
    const metaAgentType = typeof meta?.agentType === 'string' && meta.agentType ? meta.agentType : null;
    // The run's human-readable description (Task 11/D3): unlike agent_type,
    // there is no inline-pairing source for this — the sidecar is the only
    // place it exists, so it's stamped unconditionally on every event of the
    // run below (not just as a fallback).
    const metaDesc = typeof meta?.description === 'string' && meta.description.trim() ? meta.description.trim() : null;
    const fileAgentId = agentIdFromFile(ref.file);
    let agentType: string | null | undefined;
    const subEvents: Event[] = [];
    const srl = readline.createInterface({ input: fs.createReadStream(ref.file), crlfDelay: Infinity });
    for await (const line of srl) {
      if (!line.trim()) continue;
      let o: ClaudeLine;
      try { o = JSON.parse(line); } catch { skipped++; continue; }
      if (o.uuid && mainUuids.has(o.uuid)) continue; // dedup against inline main-file entries
      // Same registry as the main loop: `mainUuids` above dedups by UUID, so it
      // cannot catch a call written to both files under different uuids —
      // keying on (message.id, requestId) can.
      let callKey: string | null = null;
      if (o.type === 'assistant' && o.message?.usage) callKey = recordCall(calls, o, o.message.usage);
      const lineEvents = parseClaudeLine(o);
      if (agentType === undefined && o.type === 'user') {
        const content = o.message?.content;
        const txt = typeof content === 'string' ? content
          : Array.isArray(content) ? content.find((b) => b.type === 'text')?.text : undefined;
        if (txt) agentType = taskPromptType.get(txt.slice(0, 300)) ?? null;
      }
      let claimed = false;
      for (const e of lineEvents) {
        e.is_sidechain = 1;
        e.workflow_id = ref.workflowId;
        e.agent_id = fileAgentId; // run-level id, from the file's own name — not the line's agentId field
        if (agentType) e.agent_type = agentType;
        if (metaDesc) e.agent_desc = metaDesc;
        // Run identity is stamped ABOVE this point on purpose: claimCall's
        // cross-file tie-break reads is_sidechain/agent_id/workflow_id off the
        // candidate event.
        if (callKey && !claimed) {
          claimCall(calls, callKey, e);
          claimed = true;
        }
        subEvents.push(e);
      }
    }
    // Fallback: meta.json's agentType fills any of this agent's events that
    // pairing didn't resolve (e.g. every workflow agent — no matching inline
    // Task prompt to pair against).
    if (metaAgentType) {
      for (const e of subEvents) if (!e.agent_type) e.agent_type = metaAgentType;
    }
    events.push(...subEvents);
  }

  const timestamps = events.map((e) => e.ts).filter(Boolean).sort() as string[];
  if (cwd) cwd = reduceCwd(cwd, cwdsSeen);
  const usageByModel = foldCallsByModel(calls);
  return {
    session: {
      id: sessionId,
      source: 'claude-code',
      file_path: file,
      cwd,
      started_at: timestamps[0] ?? null,
      ended_at: timestamps[timestamps.length - 1] ?? null,
      first_prompt: firstPrompt,
      summary: customTitle || summary, // Claude Code custom title wins over legacy summary
      context_tokens: contextTokens,
      // Folded from the call registry, NOT accumulated per line — one API call
      // contributes once no matter how many transcript lines repeat it.
      usage: usageByModel.size ? JSON.stringify(Object.fromEntries(usageByModel)) : null,
      skipped,
    },
    events,
  };
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  }
  return content == null ? '' : String(content);
}

function safeStringify(v: unknown): string | null {
  try { return JSON.stringify(v); } catch { return null; }
}
