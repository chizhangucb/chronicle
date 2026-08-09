import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

export const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// Scan ~/.claude/projects for importable projects with session/message estimates.
export function scanClaudeProjects(baseDir = CLAUDE_PROJECTS_DIR) {
  if (!fs.existsSync(baseDir)) return [];
  const results = [];
  for (const dirent of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const logDir = path.join(baseDir, dirent.name);
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) continue;
    let messageEstimate = 0;
    let physicalPath = null;
    const sessions = [];
    for (const f of files) {
      const full = path.join(logDir, f);
      const stat = fs.statSync(full);
      const est = Math.max(1, Math.round(stat.size / 2000));
      messageEstimate += est;
      const head = sniffHead(full);
      if (!physicalPath && head.cwd) physicalPath = head.cwd;
      sessions.push({
        id: path.basename(f, '.jsonl'),
        file: full,
        label: head.summary,
        modifiedAt: stat.mtime.toISOString(),
        messageEstimate: est,
      });
    }
    sessions.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
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
function sniffHead(file) {
  const head = { cwd: null, summary: null };
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
    const tailCwds = [];
    for (const m of tailText.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
      try { tailCwds.push(JSON.parse(`"${m[1]}"`)); } catch {}
    }
    if (tailCwds.length) head.cwd = reduceCwd(tailCwds[tailCwds.length - 1], new Set(tailCwds.concat(head.cwd || [])));
  } catch {}
  return head;
}

// A session can record subdirectory cwds (e.g. <repo>/server). Walk the pick up
// to the shortest seen ancestor so grouping lands on the project root.
function reduceCwd(pick, seen) {
  let out = pick;
  for (const c of seen) {
    if (c && c !== out && out.startsWith(c + '/')) out = c;
  }
  return out;
}

// Parse a single JSONL entry into normalized events (shared by import + live tail).
export function parseClaudeLine(o) {
  const events = [];
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
    for (const block of o.message.content || []) {
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

// Parse one session JSONL file into { session, events }.
export async function parseClaudeSession(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const events = [];
  let sessionId = path.basename(file, '.jsonl');
  let cwd = null;
  const cwdsSeen = new Set();
  let firstPrompt = null;
  let summary = null;
  let customTitle = null;
  let skipped = 0;
  let contextTokens = null;
  const usageByModel = new Map(); // model → { input, output, cacheWrite, cacheRead }
  const taskPromptType = new Map(); // Task prompt head → subagent_type (sidechain pairing)
  const uuidAgentType = new Map();  // sidechain uuid → agent_type (parent-chain propagation)
  let pendingCommandSkill = null;   // set by a <command-name> turn, consumed by the next assistant event

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { skipped++; continue; }
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
      const agg = usageByModel.get(model) || { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
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
      let at = o.parentUuid ? uuidAgentType.get(o.parentUuid) : undefined;
      if (at === undefined && o.type === 'user') {
        const txt = typeof o.message?.content === 'string' ? o.message.content
          : o.message?.content?.find?.((b) => b.type === 'text')?.text;
        if (txt) at = taskPromptType.get(txt.slice(0, 300)) ?? null;
      }
      uuidAgentType.set(o.uuid, at ?? null);
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
      if (!usageAttached) {
        const u = o.message.usage;
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
        usageAttached = true;
      }
      if (pendingCommandSkill && !o.isSidechain && (e.kind === 'assistant' || e.kind === 'thinking' || e.kind === 'tool_use')) {
        if (!e.skill) e.skill = pendingCommandSkill;
        pendingCommandSkill = null;
      }
      events.push(e);
      if (e.kind === 'user' && !e.is_sidechain && !firstPrompt) firstPrompt = e.text.slice(0, 200);
    }
  }

  // Sidechains: current Claude Code writes subagent transcripts to separate
  // files (<logDir>/<sessionId>/subagents/agent-*.jsonl) rather than inline
  // isSidechain lines. Import them as sidechain rows: usage aggregates into the
  // session totals (real spend), context_tokens stays main-chain. agent_type is
  // paired via the main chain's Task/Agent tool_use prompt; unmatched → NULL.
  // Sidechain events are appended after the main chain (UI excludes them by
  // default; consumers order by ts).
  const subagentsDir = path.join(path.dirname(file), sessionId, 'subagents');
  if (fs.existsSync(subagentsDir)) {
    for (const sf of fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.jsonl'))) {
      let agentType;
      const subEvents = [];
      const srl = readline.createInterface({ input: fs.createReadStream(path.join(subagentsDir, sf)), crlfDelay: Infinity });
      for await (const line of srl) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { skipped++; continue; }
        if (o.type === 'assistant' && o.message?.usage) {
          const u = o.message.usage;
          const model = o.message.model || 'unknown';
          const agg = usageByModel.get(model) || { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
          agg.input += u.input_tokens || 0;
          agg.output += u.output_tokens || 0;
          agg.cacheRead += u.cache_read_input_tokens || 0;
          const cc = u.cache_creation;
          if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
            agg.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0;
            agg.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0;
          } else {
            agg.cacheWrite5m += u.cache_creation_input_tokens || 0;
          }
          usageByModel.set(model, agg);
        }
        const lineEvents = parseClaudeLine(o);
        if (agentType === undefined && o.type === 'user') {
          const txt = typeof o.message?.content === 'string' ? o.message.content
            : o.message?.content?.find?.((b) => b.type === 'text')?.text;
          if (txt) agentType = taskPromptType.get(txt.slice(0, 300)) ?? null;
        }
        let usageAttached = o.type !== 'assistant' || !o.message?.usage;
        for (const e of lineEvents) {
          e.is_sidechain = 1;
          if (agentType) e.agent_type = agentType;
          if (!usageAttached) {
            const u = o.message.usage;
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
            usageAttached = true;
          }
          subEvents.push(e);
        }
      }
      events.push(...subEvents);
    }
  }

  const timestamps = events.map((e) => e.ts).filter(Boolean).sort();
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

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  }
  return content == null ? '' : String(content);
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return null; }
}
