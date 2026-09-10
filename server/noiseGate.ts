// Noise gate (Phase 5 PR 5a): sessions under a size/duration threshold don't
// clutter the main lists — they land in a single global "minor sessions"
// bucket instead (promote / ignore actions surface it). Applied uniformly at
// insert time by db.ts `replaceSession`, so it covers manual import,
// per-project/per-session sync, AND auto-sync alike.
//
// Thresholds come from the one config module. That module imports nothing of
// Chronicle's, which is what lets the gate read the config at all: the gate is
// imported by db.ts, so reading it out of autosync.ts (which imports
// replaceSession from db.ts) would close an import cycle.
import { readConfig } from './config.ts';

export const DEFAULT_MINOR_ACTIVE_MS = 5 * 60 * 1000; // 5 min
export const DEFAULT_MINOR_MESSAGE_COUNT = 10;

// A session is "minor" (below the noise-gate threshold) only when it is short
// on BOTH axes: agent-active time under the active-ms threshold AND fewer
// messages than the message-count threshold. AND (not OR) so a substantive
// session never gets hidden on one axis alone — e.g. a 37-message working
// session that happened to run under 5 min of agent-active time is real work,
// not noise, and stays in the main lists. Both thresholds tunable via
// ~/.chronicle/config.json; noise is the true one-shot (few messages AND brief).
export function isMinorSession(agentActiveMs: number, messageCount: number): boolean {
  const cfg = readConfig();
  const activeThreshold = cfg.minorActiveMsThreshold ?? DEFAULT_MINOR_ACTIVE_MS;
  const countThreshold = cfg.minorMessageCountThreshold ?? DEFAULT_MINOR_MESSAGE_COUNT;
  return (agentActiveMs ?? 0) < activeThreshold && (messageCount ?? 0) < countThreshold;
}
