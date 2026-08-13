// Task 4 (quality-pass plan §2.8): the auto-sync debounce must not let
// continuous file activity starve a sync until the 30-min backstop. Every
// fs-watch event resets the plain DEBOUNCE_MS timer; under continuous churn
// that reset never lets the timer fire. nextDelay() clamps the delay so the
// FIRST pending event in a burst still fires within MAXWAIT_MS, even if
// later events keep arriving.
//
// This file tests the pure nextDelay() helper directly, then exercises the
// real state transitions (scheduleDebounced / runIncrementalSync) against a
// temp DB, following the same withTempDb() pattern as sync-hygiene.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule;
let autosync;
let teardown;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  autosync = await import('../server/autosync.ts');
});

after(() => {
  autosync.stopAutoSync(); // clear any live timers scheduleDebounced() started
  teardown();
});

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

test('nextDelay: a burst that has been pending near MAXWAIT_MS gets a short (<=10s) delay, not the full debounce', () => {
  const now = Date.now();
  const firstPendingAt = now - 110_000; // pending 110s into a 120s max wait
  const delay = autosync.nextDelay(now, firstPendingAt);
  assert.ok(delay <= 10_000, `expected delay <= 10s, got ${delay}ms`);
  assert.ok(delay >= 0, `delay must never be negative, got ${delay}ms`);
});

test('nextDelay: a fresh burst (firstPendingAt = now) returns the full 30s debounce', () => {
  const now = Date.now();
  assert.equal(autosync.nextDelay(now, now), 30_000);
});

test('nextDelay: no pending burst yet (firstPendingAt = null) also returns the full 30s debounce', () => {
  const now = Date.now();
  assert.equal(autosync.nextDelay(now, null), 30_000);
});

test('nextDelay: never exceeds DEBOUNCE_MS even when firstPendingAt is in the future', () => {
  const now = Date.now();
  assert.equal(autosync.nextDelay(now, now + 1_000_000), 30_000);
});

test('nextDelay: clamps to 0 once MAXWAIT_MS has fully elapsed', () => {
  const now = Date.now();
  const firstPendingAt = now - 5 * 60_000; // 5 minutes ago, way past the 2-min max wait
  assert.equal(autosync.nextDelay(now, firstPendingAt), 0);
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

test('scheduleDebounced: the first event in a quiet period sets firstPendingAt', () => {
  autosync.stopAutoSync();
  assert.equal(autosync.autoSyncStatus().firstPendingAt, null, 'precondition: no pending burst');

  autosync.scheduleDebounced();
  const status = autosync.autoSyncStatus();
  assert.ok(status.firstPendingAt !== null, 'firstPendingAt should be set by the first event');
  assert.ok(Math.abs(status.firstPendingAt - Date.now()) < 1000, 'firstPendingAt should be ~now');

  autosync.stopAutoSync();
});

test('scheduleDebounced: subsequent events during the same burst do NOT move firstPendingAt forward', () => {
  autosync.stopAutoSync();
  autosync.scheduleDebounced();
  const first = autosync.autoSyncStatus().firstPendingAt;

  // Simulate continuous churn: repeated events shortly after the first.
  autosync.scheduleDebounced();
  autosync.scheduleDebounced();
  const stillFirst = autosync.autoSyncStatus().firstPendingAt;

  assert.equal(stillFirst, first, 'firstPendingAt must stay pinned to the start of the burst, not reset per-event');
  autosync.stopAutoSync();
});

test('runIncrementalSync: a completed run clears firstPendingAt', async () => {
  autosync.stopAutoSync();
  autosync.scheduleDebounced();
  assert.ok(autosync.autoSyncStatus().firstPendingAt !== null, 'precondition: a burst is pending');

  await autosync.runIncrementalSync();

  assert.equal(autosync.autoSyncStatus().firstPendingAt, null, 'a completed sync run should clear firstPendingAt');
  autosync.stopAutoSync();
});
