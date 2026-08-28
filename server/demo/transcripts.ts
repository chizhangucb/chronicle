// Writes the demo corpus out as real Claude Code transcripts (CHI-325 3c).
//
// A shipped twin of test/fixtures/gen-mini-session.mjs. It is a separate file
// rather than an import because `test/` is not in package.json `files`, so the
// published CLI cannot reach the fixture generator. It writes the same JSONL
// shape, so the demo goes through the real parser rather than a special path.
//
// This one adds what the walk fixture does not need but a full-product demo
// does: tool calls, tool results (some of them errors), MCP calls, skills, and
// subagent sidechains. Those are what make the Content tab, the error rate, the
// MCP spend rows and the Subagents card show anything at all.
import fs from 'node:fs';
import path from 'node:path';
import type { DemoSessionSpec } from './corpus.ts';

const TOOLS = ['Bash', 'Read', 'Edit', 'Grep', 'Write', 'Glob'];
const MCP_TOOLS = ['mcp__linear__list_issues', 'mcp__playwright__browser_click', 'mcp__docmost__get_page'];
const SKILLS = ['code-review', 'frontend-design', 'dataviz'];

function mungeProjectDir(cwd: string): string {
  return cwd.replace(/\//g, '-');
}
function jsonLine(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

/**
 * Write one demo session as a Claude Code JSONL transcript.
 *
 * `seedFor` keeps every session deterministic from its own id, so regenerating
 * the corpus produces byte-identical transcripts and a demo screenshot taken
 * today matches one taken tomorrow.
 */
export function writeDemoSession(destDir: string, spec: DemoSessionSpec, nowMs: number): string {
  const projectDir = path.join(destDir, mungeProjectDir(spec.cwd));
  fs.mkdirSync(projectDir, { recursive: true });

  // Today's sessions must land AFTER local midnight, not merely 3h before now.
  // A plain `now - 3h` silently falls onto YESTERDAY whenever the demo is first
  // built between midnight and 03:00, and the console then opens on an empty
  // Today window with $0 and 0 sessions, which is the opposite of what a demo
  // is for. Clamped to just after midnight; older days start mid-morning local.
  const midnight = (() => { const d = new Date(nowMs); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const start = spec.daysAgo === 0
    ? Math.max(midnight + 5 * 60_000, nowMs - 3 * 3600_000)
    : (() => {
      const d = new Date(nowMs - spec.daysAgo * 86_400_000);
      d.setHours(10, 15, 0, 0);
      return d.getTime();
    })();

  let seed = 0;
  for (const ch of spec.sessionId) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = (() => {
    let a = seed || 1;
    return () => {
      a ^= a << 13; a >>>= 0;
      a ^= a >> 17;
      a ^= a << 5; a >>>= 0;
      return a / 4294967296;
    };
  })();

  // A session must never end in the FUTURE. Just after midnight the clamp above
  // leaves only minutes of runway, so today's sessions compress to fit.
  //
  // The slot count is the WORST case, not the average: every turn can emit
  // three rows (user, assistant, tool result) and a session can append three
  // more subagent rows. Budgeting for turns*2 (the first attempt) overshot
  // `now` whenever a session actually used its tools. When compressing, the
  // tool-result and subagent advances use the same computed gap rather than
  // their fixed sizes, or they would blow the budget right back open.
  const room = Math.max(0, nowMs - start);
  const worstCaseRows = spec.turns * 3 + 3;
  const compress = spec.daysAgo === 0;
  // Still capped at the normal 50s: without the cap a midday rebuild has ~3h
  // of runway and would stretch today's gaps to minutes, inflating agent-active
  // time for exactly the sessions the Today window shows.
  const gapMs = compress ? Math.max(200, Math.min(50_000, Math.floor(room / worstCaseRows))) : 50_000;
  const resultGapMs = compress ? gapMs : 4_000;
  const agentGapMs = compress ? gapMs : 12_000;
  let cursor = start;
  let parentUuid: string | null = null;
  const lines: string[] = [];

  for (let turn = 0; turn < spec.turns; turn++) {
    const userUuid = `${spec.sessionId}-u${turn}`;
    lines.push(jsonLine({
      type: 'user', sessionId: spec.sessionId, cwd: spec.cwd,
      uuid: userUuid, parentUuid,
      timestamp: new Date(cursor).toISOString(),
      message: { role: 'user', content: turn === 0 ? spec.promptText : `${spec.promptText} (follow-up ${turn + 1})` },
    }));
    parentUuid = userUuid;
    cursor += gapMs;

    const asstUuid = `${spec.sessionId}-a${turn}`;
    // Roughly every other turn calls a tool; a tenth of those are MCP calls, so
    // the MCP spend card has rows without dominating the tool mix.
    const usesTool = rnd() < 0.65;
    const isMcp = usesTool && rnd() < 0.18;
    const toolName = isMcp
      ? MCP_TOOLS[Math.floor(rnd() * MCP_TOOLS.length)]
      : TOOLS[Math.floor(rnd() * TOOLS.length)];
    const toolUseId = `${spec.sessionId}-t${turn}`;

    const content: unknown[] = [{ type: 'text', text: `Working on step ${turn + 1}.` }];
    if (usesTool) content.push({ type: 'tool_use', id: toolUseId, name: toolName, input: { command: 'demo' } });

    lines.push(jsonLine({
      type: 'assistant', sessionId: spec.sessionId,
      uuid: asstUuid, parentUuid,
      timestamp: new Date(cursor).toISOString(),
      message: {
        role: 'assistant',
        model: spec.model,
        content,
        usage: spec.usage,
        ...(rnd() < 0.25 ? { skill: SKILLS[Math.floor(rnd() * SKILLS.length)] } : {}),
      },
    }));
    parentUuid = asstUuid;
    cursor += gapMs;

    if (usesTool) {
      // ~4% of results are errors: enough that the error-rate KPI and the
      // per-project error chart are not a flat zero, low enough that the
      // detector reads as healthy. The demo carries exactly ONE deliberate
      // alarm (the spike day the anomaly tile flags); a second red state would
      // make a first-run console look broken rather than interesting.
      const failed = rnd() < 0.04;
      const resUuid = `${spec.sessionId}-r${turn}`;
      lines.push(jsonLine({
        type: 'user', sessionId: spec.sessionId,
        uuid: resUuid, parentUuid,
        timestamp: new Date(cursor).toISOString(),
        message: {
          role: 'user',
          content: [{
            type: 'tool_result', tool_use_id: toolUseId,
            content: failed ? 'Error: command failed with exit code 1' : 'ok (demo result)',
            is_error: failed,
          }],
        },
      }));
      parentUuid = resUuid;
      cursor += resultGapMs;
    }
  }

  // One subagent sidechain on a minority of sessions, so the Subagents card and
  // the subagent share on the Content tab have something to show.
  if (rnd() < 0.3) {
    const agentId = `${spec.sessionId}-agent`;
    for (let k = 0; k < 3; k++) {
      lines.push(jsonLine({
        type: 'assistant', sessionId: spec.sessionId,
        uuid: `${agentId}-${k}`, parentUuid,
        isSidechain: true,
        timestamp: new Date(cursor).toISOString(),
        message: {
          role: 'assistant', model: spec.model,
          content: [{ type: 'text', text: `Subagent step ${k + 1}.` }],
          usage: { input_tokens: 900, output_tokens: 300 },
        },
      }));
      cursor += agentGapMs;
    }
  }

  const file = path.join(projectDir, `${spec.sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join(''));
  return file;
}
