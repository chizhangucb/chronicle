import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { Event, ModelUsage, ParseResult, ScannedProject, ScannedSession } from '../../shared/types.ts';

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
}

// Sidecar written next to a subagent transcript file (agent-<hex>.meta.json).
// Only agentType is consumed today; other fields (description, toolUseId,
// spawnDepth) are read but not yet surfaced.
interface AgentMeta {
  agentType?: string;
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
function reduceCwd(pick: string, seen: Set<string>): string {
  let out = pick;
  for (const c of seen) {
    if (c && c !== out && out.startsWith(c + '/')) out = c;
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
  }
  if (o.isSidechain) for (const e of events) e.is_sidechain = 1;
  return events;
}

function newUsageAgg(): ModelUsage {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function accumulateUsage(usageByModel: Map<string, ModelUsage>, model: string, u: ClaudeUsage): void {
  const agg = usageByModel.get(model) || newUsageAgg();
  agg.input += u.input_tokens || 0;
  agg.output += u.output_tokens || 0;
  agg.cacheRead += u.cache_read_input_tokens || 0;
  // 5-minute and 1-hour cache writes are billed at different rates.
  const cc = u.cache_creation;
  if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    agg.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0;
    agg.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0;
  } else {
    agg.cacheWrite5m += u.cache_creation_input_tokens || 0; // default tier when unsplit
  }
  usageByModel.set(model, agg);
}

function attachPerEventUsage(e: Event, u: ClaudeUsage): void {
  const cc = u.cache_creation;
  e.input_tokens = u.input_tokens || 0;
  e.output_tokens = u.output_tokens || 0;
  e.cache_read_tokens = u.cache_read_input_tokens || 0;
  if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
    e.cache_w5m_tokens = cc.ephemeral_5m_input_tokens || 0;
    e.cache_w1h_tokens = cc.ephemeral_1h_input_tokens || 0;
  } else {
    e.cache_w5m_tokens = u.cache_creation_input_tokens || 0;
    e.cache_w1h_tokens = 0;
  }
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
  const usageByModel = new Map<string, ModelUsage>();
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
    if (o.type === 'assistant' && o.message?.usage) {
      const u = o.message.usage;
      if (!o.isSidechain) {
        const ctx = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (ctx > 0) contextTokens = ctx;
      }
      const model = o.message.model || 'unknown';
      accumulateUsage(usageByModel, model, u);
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
    }
    let usageAttached = o.type !== 'assistant' || !o.message?.usage;
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
      // Per-message usage: one API call = one set of numbers, stored on the
      // FIRST event of that assistant line (others NULL).
      if (!usageAttached && o.message?.usage) {
        attachPerEventUsage(e, o.message.usage);
        usageAttached = true;
      }
      if (pendingCommandSkill && !o.isSidechain && (e.kind === 'assistant' || e.kind === 'thinking' || e.kind === 'tool_use')) {
        if (!e.skill) e.skill = pendingCommandSkill;
        pendingCommandSkill = null;
      }
      events.push(e);
      if (e.kind === 'user' && !e.is_sidechain && !firstPrompt) firstPrompt = (e.text ?? '').slice(0, 200);
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
    let agentType: string | null | undefined;
    const subEvents: Event[] = [];
    const srl = readline.createInterface({ input: fs.createReadStream(ref.file), crlfDelay: Infinity });
    for await (const line of srl) {
      if (!line.trim()) continue;
      let o: ClaudeLine;
      try { o = JSON.parse(line); } catch { skipped++; continue; }
      if (o.uuid && mainUuids.has(o.uuid)) continue; // dedup against inline main-file entries
      if (o.type === 'assistant' && o.message?.usage) {
        const u = o.message.usage;
        const model = o.message.model || 'unknown';
        accumulateUsage(usageByModel, model, u);
      }
      const lineEvents = parseClaudeLine(o);
      if (agentType === undefined && o.type === 'user') {
        const content = o.message?.content;
        const txt = typeof content === 'string' ? content
          : Array.isArray(content) ? content.find((b) => b.type === 'text')?.text : undefined;
        if (txt) agentType = taskPromptType.get(txt.slice(0, 300)) ?? null;
      }
      let usageAttached = o.type !== 'assistant' || !o.message?.usage;
      for (const e of lineEvents) {
        e.is_sidechain = 1;
        e.workflow_id = ref.workflowId;
        if (agentType) e.agent_type = agentType;
        if (!usageAttached && o.message?.usage) {
          attachPerEventUsage(e, o.message.usage);
          usageAttached = true;
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
