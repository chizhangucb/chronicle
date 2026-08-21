// Unit tests for splitAutomation (src/windowedUsage.ts, CHI-233 Part C): splits
// in-window sessions into an INTERACTIVE headline count (manifest ids excluded)
// and an AUTOMATION bucket by job. Present-transcript automation is priced from
// the transcript's windowed cells (transcript wins); absent-transcript
// automation is priced from the manifest usage cells via costOf. The dedup rule
// (never count a manifest session twice) is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAutomation } from '../src/windowedUsage.ts';

function cell(input = 0, output = 0, cacheRead = 0, cacheWrite5m = 0, cacheWrite1h = 0) {
  return { input, output, cacheRead, cacheWrite5m, cacheWrite1h };
}
// A windowed (day-bucketed) transcript cell.
function wcell(sessionId, model, cells, bucket = '2026-09-01') {
  return { sessionId, projectId: 1, model, source: 'claude-code', cells, bucket };
}
// A manifest automation session.
function msess(sessionId, job, model, usage, ts = '2026-09-01T06:00:00Z', cost_usd = null) {
  return { sessionId, job, model, usage, ts, cost_usd };
}

// Post-cutover day → claude-sonnet-5 $3/$15, claude-opus $5/$25, claude-haiku $1/$5.
const dbSessions = [{ id: 's-int' }, { id: 's-auto' }];
const windowed = [
  wcell('s-int', 'claude-sonnet-5', cell(1_000_000, 0)),   // interactive: 1M input @ $3 = $3
  wcell('s-auto', 'claude-opus', cell(0, 1_000_000)),       // present automation: 1M output @ $25 = $25
];
const machine = {
  ids: ['s-auto', 's-absent'],
  sessions: [
    // present (transcript in DB) — manifest usage is deliberately HUGE to prove
    // the transcript wins (dedup), never summed on top.
    msess('s-auto', 'weekly', 'claude-opus', cell(999_000_000, 999_000_000)),
    // absent (no transcript) — priced from these manifest cells via costOf.
    msess('s-absent', 'nightly', 'claude-haiku', cell(1_000_000, 0)),
  ],
};

test('splitAutomation: manifest ids are excluded from the interactive count', () => {
  const r = splitAutomation(dbSessions, windowed, machine);
  // s-int is the only interactive session; s-auto is a manifest id → automation.
  assert.equal(r.interactiveSessionCount, 1);
});

test('splitAutomation: automation bucket is attributed by job', () => {
  const r = splitAutomation(dbSessions, windowed, machine);
  const jobs = Object.fromEntries(r.byJob.map((b) => [b.job, b]));
  assert.ok(jobs.weekly);
  assert.ok(jobs.nightly);
  assert.equal(jobs.weekly.sessions, 1);
  assert.equal(jobs.nightly.sessions, 1);
});

test('splitAutomation: absent-transcript session is priced from its manifest cells via costOf', () => {
  const r = splitAutomation(dbSessions, windowed, machine);
  const nightly = r.byJob.find((b) => b.job === 'nightly');
  // claude-haiku 1M input @ $1/1M = $1.
  assert.equal(nightly.cost, 1);
});

test('splitAutomation: DEDUP — a present manifest session is priced from the transcript, NOT the manifest snapshot, and counted once', () => {
  const r = splitAutomation(dbSessions, windowed, machine);
  const weekly = r.byJob.find((b) => b.job === 'weekly');
  // Transcript: 1M output @ $25 = $25. If the huge manifest usage leaked in,
  // this would be thousands of dollars.
  assert.equal(weekly.cost, 25);
  assert.equal(weekly.sessions, 1);
  // Total automation sessions = present (s-auto) + absent (s-absent), each once.
  assert.equal(r.automationSessionCount, 2);
  assert.equal(r.automationCost, 25 + 1);
});

test('splitAutomation: single-count invariant — interactive + automation covers each session exactly once', () => {
  const r = splitAutomation(dbSessions, windowed, machine);
  // 1 interactive (s-int) + 2 automation (s-auto present, s-absent) = 3 distinct
  // sessions, no overlap: s-auto is automation only, never also interactive.
  assert.equal(r.interactiveSessionCount + r.automationSessionCount, 3);
});

test('splitAutomation: real mode returns 0 automation cost for subscription-covered models (theoretical unchanged)', () => {
  const real = splitAutomation(dbSessions, windowed, machine, 'real');
  assert.equal(real.automationCost, 0); // opus + haiku both covered
  const theo = splitAutomation(dbSessions, windowed, machine, 'theoretical');
  assert.equal(theo.automationCost, 26);
});

test('splitAutomation: real mode also zeroes a gpt-5.6 automation session; theoretical prices it', () => {
  const gptMachine = {
    ids: ['s-gpt'],
    sessions: [msess('s-gpt', 'spend-advice', 'gpt-5.6-terra', cell(1_000_000, 1_000_000))],
  };
  const theo = splitAutomation([], [], gptMachine, 'theoretical');
  assert.equal(theo.automationCost, 2 + 12); // terra 2/12 per 1M
  const real = splitAutomation([], [], gptMachine, 'real');
  assert.equal(real.automationCost, 0);
});

test('splitAutomation: empty manifest → everything is interactive, no automation', () => {
  const r = splitAutomation(dbSessions, windowed, { ids: [], sessions: [] });
  assert.equal(r.interactiveSessionCount, 2);
  assert.equal(r.automationSessionCount, 0);
  assert.equal(r.automationCost, 0);
  assert.equal(r.byJob.length, 0);
});

test('splitAutomation: absent-transcript falls back to cost_usd only when the model is unpriced', () => {
  const unpricedMachine = {
    ids: ['s-x'],
    sessions: [msess('s-x', 'weekly', 'some-unknown-model', cell(1_000_000), '2026-09-01T06:00:00Z', 0.07)],
  };
  const r = splitAutomation([], [], unpricedMachine);
  // costOf returns null for the unknown model → cost_usd fallback.
  assert.ok(Math.abs(r.automationCost - 0.07) < 1e-9);
});
