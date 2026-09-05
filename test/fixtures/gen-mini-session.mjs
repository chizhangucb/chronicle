// Deterministic MINI-session fixture generator — a handful of small Claude
// Code JSONL sessions, used by the Task-14 select.spec.ts to exercise
// day-group headers, filtered "Select all", and the minor-sessions bucket.
//
// The Task-1 big-session fixture (gen-big-session.mjs) deliberately has ONE
// session on ONE day, which can't exercise day-group tri-state selection or
// filtered multi-row "Select all". Rather than touch gen-big-session.mjs's
// own output/constants (other tests assert on those), this is a separate,
// additive generator: `writeMiniSession()` drops one more small .jsonl file
// into the SAME munged project directory as the big fixture (scanned as an
// extra session of that project — see server/parsers/claudeCode.ts
// scanClaudeProjects, which lists every *.jsonl directly under a project
// dir as a session).
//
// Determinism: fixed per-call inputs only (no Date.now()/Math.random()), so
// repeat generations are byte-identical.
import fs from 'node:fs';
import path from 'node:path';

// Matches gen-big-session.mjs's own FIXTURE_CWD — kept as a literal here
// (rather than importing) so this file never has to touch gen-big-session.mjs.
export const MINI_DEFAULT_CWD = '/tmp/fixture-project';

function mungeProjectDir(cwd) {
  return cwd.replace(/\//g, '-');
}

function jsonLine(obj) {
  return JSON.stringify(obj) + '\n';
}

/**
 * Write one small, deterministic Claude Code session JSONL.
 *
 * @param {string} destDir - directory to write the munged project dir into (same fixtureDir the big session uses).
 * @param {object} opts
 * @param {string} opts.sessionId - unique session id.
 * @param {string} opts.dateISO - UTC ISO instant the session starts at (drives which day-group it lands in).
 * @param {string} opts.promptText - first user message text (becomes the row's title via `first_prompt`).
 * @param {string} [opts.cwd] - project cwd (defaults to the big fixture's, so it lands in the same scanned project).
 * @param {number} [opts.turns] - user/assistant turn pairs. 2 turns (4 events) is always "minor"
 *   (server/noiseGate.ts: messageCount < 10). 8 turns (16 events) with 50s user→assistant gaps clears
 *   BOTH the message-count (>=10) and 5-min agent-active thresholds, so it lands in the main ledger.
 * @param {number} [opts.gapSec] - seconds between each message. Ignored when `endISO` is given.
 * @param {string} [opts.model] - assistant model id (defaults to 'claude-fable-5', byte-identical
 *   to every pre-existing caller). Set it to seed vendor variety: the model VENDOR (shared/provider.ts
 *   providerOf) keys off this string's prefix, so 'gpt-5' -> openai, 'gemini-2.5-pro' -> google,
 *   'mistral-large-2' -> other (off-roster/unpriced). Used by scripts/walk-seed.mjs.
 * @param {{input_tokens:number,output_tokens:number,cache_read_input_tokens?:number}} [opts.usage] -
 *   per-assistant-message token usage (defaults to a small fixed bag). Vary it per vendor so the
 *   Spend median dash + routing table show a real spread.
 * @param {string} [opts.endISO] - UTC ISO instant the LAST message should land on. When given, the
 *   per-message gap is derived (`(endTs - startTs) / (turns * 2 - 1)`) instead of using `gapSec`, so a
 *   caller can pin both ends of a session (e.g. "started 26h ago, still going 5 minutes ago") without
 *   hand-computing a gap. Used by the range-matrix fixture (Task 7, D-series) for sessions whose
 *   absolute timestamps are relative to Date.now() AT SEED TIME rather than a fixed calendar date.
 * @returns {{sessionId: string, file: string}}
 */
export function writeMiniSession(destDir, opts) {
  const {
    sessionId, dateISO, promptText, cwd = MINI_DEFAULT_CWD, turns = 8, endISO,
    model = 'claude-fable-5',
    usage = { input_tokens: 80, output_tokens: 40, cache_read_input_tokens: 0 },
  } = opts;
  const projectDir = path.join(destDir, mungeProjectDir(cwd));
  fs.mkdirSync(projectDir, { recursive: true });

  const baseTs = Date.parse(dateISO);
  // BUG GUARD: Date.parse()'s difference is in MILLISECONDS — divide by 1000
  // before dividing by message count, or the result (already effectively
  // milliseconds) gets treated as seconds and re-multiplied by 1000 below,
  // inflating every gap ~1000x (caught live: a "26h ago -> 5 min ago" session
  // landed its last message in 2029, not the same day — see task-7-report.md).
  //
  // GAP-COUNT BUG GUARD (round 2 review finding): the loop below writes 2
  // messages per turn (2*turns total) but the FIRST message is written at
  // `cursor` BEFORE any `cursor += gapSec*1000` advance — so there are only
  // `2*turns - 1` gaps between the first and last recorded message, not
  // `2*turns`. Dividing by `turns*2` (one gap too many) understated the true
  // per-gap spacing, so the last message landed one gapSec short of `endISO`
  // — for the spanning-session fixture (turns=30, ~26h span) that was ~26
  // minutes early, silently violating the "ends ~5 min before now" guarantee
  // range-matrix.spec.ts's isolation assertions depend on.
  const gapSec = endISO
    ? Math.max(1, Math.round((Date.parse(endISO) - baseTs) / 1000 / Math.max(1, turns * 2 - 1)))
    : (opts.gapSec ?? 50);
  let cursor = baseTs;
  let parentUuid = null;
  const lines = [];

  for (let t = 0; t < turns; t++) {
    const userUuid = `${sessionId}-u${t}`;
    lines.push(jsonLine({
      type: 'user',
      sessionId,
      cwd,
      uuid: userUuid,
      parentUuid,
      timestamp: new Date(cursor).toISOString(),
      message: { role: 'user', content: t === 0 ? promptText : `${promptText} (follow-up ${t + 1})` },
    }));
    parentUuid = userUuid;
    cursor += gapSec * 1000;

    const asstUuid = `${sessionId}-a${t}`;
    lines.push(jsonLine({
      type: 'assistant',
      sessionId,
      uuid: asstUuid,
      parentUuid,
      timestamp: new Date(cursor).toISOString(),
      message: {
        role: 'assistant',
        model,
        content: [{ type: 'text', text: `Mini fixture response ${t + 1}.` }],
        usage,
      },
    }));
    parentUuid = asstUuid;
    cursor += gapSec * 1000;
  }

  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join(''));
  return { sessionId, file };
}
