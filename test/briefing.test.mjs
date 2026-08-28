// Pins the briefing state machine + validator + resolver + routes (CHI-323 3d).
// Pure functions carry most of the value. CHRONICLE_DATA_DIR is a temp dir
// BEFORE import (the two-file split + the demo-file read resolve from it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-briefing-'));
process.env.CHRONICLE_DATA_DIR = data;

const b = await import('../server/briefing.ts');
const v = await import('../server/briefing-validate.ts');
const r = await import('../server/briefing-resolve.ts');
const { mountBriefing } = await import('../server/routes/briefing.ts');

const NOW = new Date('2026-08-26T12:00:00Z');

// ---- state machine ----
test('applyCardAction: done/snooze/reopen; activity survives', () => {
  let s = { version: 1, cards: {} };
  s = b.applyCardAction(s, 'c1', 'done', NOW);
  assert.equal(s.cards.c1.state, 'done');
  s = b.recordWorkedOn(s, 'c1', NOW);
  assert.ok(s.cards.c1.workedAt);
  s = b.applyCardAction(s, 'c1', 'reopen', NOW);
  assert.equal(s.cards.c1.state, 'open'); // reopen keeps workedAt, so entry stays open
  assert.ok(s.cards.c1.workedAt);
  s = b.applyCardAction(s, 'c1', 'snooze', NOW);
  assert.equal(s.cards.c1.state, 'snoozed');
  assert.ok(s.cards.c1.snoozedUntil);
});

test('reopen overrides a demo baseline state (CHI-325 review)', () => {
  // The bug: reopen used to DELETE the state entry when there was nothing to
  // keep. That only works if the operator's state file is the ONLY source of a
  // card's state, and it is not: withDemoStates layers a demo file's shipped
  // states UNDERNEATH it. So on a demo console the deleted key let the demo's
  // "snoozed" reassert itself and Reopen did visibly nothing, forever.
  //
  // The prior test only exercised reopen AFTER recordWorkedOn, which took the
  // other branch and passed throughout.
  const file = {
    version: 1, generatedAt: NOW.toISOString(), cadence: 'daily', isDemo: true,
    cards: [{ id: 'c1', runAt: NOW.toISOString(), kind: 'k', domain: 'safety', needsYou: true, title: 't', summary: 's' }],
    demoStates: { c1: { state: 'snoozed', at: NOW.toISOString(), snoozedUntil: new Date(NOW.getTime() + 86400000).toISOString() } },
  };
  // Baseline: the demo state shows through when the operator has said nothing.
  assert.equal(b.resolveCards(file, b.withDemoStates(file, { version: 1, cards: {} }), NOW)[0].state, 'snoozed');

  // Reopen with no prior operator entry and nothing to keep: the exact path.
  const after = b.applyCardAction({ version: 1, cards: {} }, 'c1', 'reopen', NOW);
  assert.equal(after.cards.c1.state, 'open', 'reopen must write an explicit open entry, not delete the key');
  assert.ok(after.cards.c1.at, 'reopen records when it happened');
  assert.equal(
    b.resolveCards(file, b.withDemoStates(file, after), NOW)[0].state, 'open',
    'the operator reopening a card must win over the demo baseline',
  );
});

test('resolveCards: an expired snooze resolves back to open', () => {
  const file = { version: 1, generatedAt: '', cadence: 'daily', cards: [{ id: 'c1', runAt: NOW.toISOString(), kind: 'k', domain: 'jobs', needsYou: true, title: 't', summary: 's' }] };
  const past = new Date(NOW.getTime() - 86400000).toISOString();
  const state = { version: 1, cards: { c1: { state: 'snoozed', at: past, snoozedUntil: past } } };
  assert.equal(b.resolveCards(file, state, NOW)[0].state, 'open');
});

test('followThrough counts terminal outcomes, not snoozes', () => {
  const cards = [
    { state: 'done', actedAt: NOW.toISOString(), runAt: new Date(NOW.getTime() - 3600000).toISOString() },
    { state: 'snoozed', actedAt: NOW.toISOString(), runAt: NOW.toISOString() },
    { state: 'open', actedAt: null, runAt: NOW.toISOString() },
  ];
  const ft = b.followThrough(cards, 3);
  assert.equal(ft.open, 1);
  assert.equal(ft.snoozed, 1);
  assert.equal(ft.actedWithinDays, 1); // the one done card, within 3 days
});

test('readBriefingFile: demo file rebases dates to now; example is the empty fallback', async () => {
  const file = await b.readBriefingFile({ ...process.env, CHRONICLE_DEMO: '1' }, NOW);
  assert.equal(file.isDemo, true);
  assert.ok(file.cards.length >= 2);
  // newest card runAt slid to ~now
  const newest = Math.max(...file.cards.map((c) => new Date(c.runAt).getTime()));
  assert.ok(Math.abs(newest - NOW.getTime()) < 1000);
});

// ---- validator (CHI-324 2i: spend domain accepted) ----
test('validator accepts a spend-domain card (CHI-324 2i)', () => {
  const out = v.validateBriefingRun({ cards: [{ id: 'spend-anomaly:2026-08-26', kind: 'spend-anomaly', domain: 'spend', needsYou: true, title: 't', summary: 's' }] }, NOW);
  assert.equal(out.cards.length, 1);
  assert.equal(out.dropped.length, 0);
  assert.equal(out.cards[0].domain, 'spend');
});

test('validator: valid card passes, duplicate id + over-cap dropped', () => {
  const good = { id: 'job-stale:x', kind: 'job-stale', domain: 'jobs', needsYou: true, title: 't', summary: 's' };
  const out = v.validateBriefingRun({ cards: [good, { ...good }] }, NOW);
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].runAt, NOW.toISOString()); // wrapper stamps time, not the model
});

test('extractJson pulls the object out of fenced/prose replies; isDue weekly rule', () => {
  assert.deepEqual(v.extractJson('```json\n{"cards":[]}\n```'), { cards: [] });
  assert.deepEqual(v.extractJson('here you go {"cards":[]} thanks'), { cards: [] });
  assert.equal(v.isDue('daily', null, NOW), true);
  assert.equal(v.isDue('weekly', NOW.toISOString(), NOW), false); // just ran, not Monday
});

// ---- resolver ----
test('mergeRuns keeps the first runAt for a re-emitted id; autoResolve clears a fixed job', () => {
  const first = new Date('2026-08-20T00:00:00Z').toISOString();
  const prev = [{ id: 'job-stale:j', runAt: first, kind: 'job-stale', domain: 'jobs', needsYou: true, title: 'old', summary: 's' }];
  const next = [{ id: 'job-stale:j', runAt: NOW.toISOString(), kind: 'job-stale', domain: 'jobs', needsYou: true, title: 'new', summary: 's2' }];
  const merged = r.mergeRuns(prev, next, { version: 1, cards: {} }, NOW);
  assert.equal(merged[0].runAt, first); // kept
  assert.equal(merged[0].title, 'new'); // refreshed

  const file = { version: 1, generatedAt: '', cadence: 'daily', cards: merged };
  const live = { jobs: { jobs: [{ id: 'j', status: 'success', lastExit: 0 }] } };
  const { resolvedIds } = r.autoResolve(file, { version: 1, cards: {} }, live, NOW);
  assert.deepEqual(resolvedIds, ['job-stale:j']); // condition no longer fires
});

// ---- spend (CHI-324 2i) ----
test('spend-anomaly resolves when the spike day has rolled past or is no longer flagged', () => {
  const card = { id: 'spend-anomaly:2026-08-26', kind: 'spend-anomaly', domain: 'spend', needsYou: false, title: 't', summary: 's', runAt: NOW.toISOString() };
  // same day, still flagged -> stands
  assert.equal(r.checkCardResolved(card, { spend: { today: '2026-08-26', anomaly: { flagged: true } } }, NOW), false);
  // same day, no longer flagged -> resolves
  assert.equal(r.checkCardResolved(card, { spend: { today: '2026-08-26', anomaly: { flagged: false } } }, NOW), true);
  // day rolled past the spike day -> resolves (historical)
  assert.equal(r.checkCardResolved(card, { spend: { today: '2026-08-27', anomaly: { flagged: true } } }, NOW), true);
  // no spend slice -> left alone (stands, not auto-resolved)
  assert.equal(r.checkCardResolved(card, {}, NOW), false);
});

// ---- budget posture (CHI-366) ----
test('budget-posture resolves on month-roll or return to on-track, stands while over/approaching', () => {
  const card = { id: 'budget-posture:2026-08', kind: 'budget-posture', domain: 'spend', needsYou: true, title: 't', summary: 's', runAt: NOW.toISOString() };
  const spend = (today, word) => ({ spend: { today, budget: { state: word ? { word } : null } } });
  // same month, still over budget -> stands
  assert.equal(r.checkCardResolved(card, spend('2026-08-28', 'over budget'), NOW), false);
  // same month, still approaching -> stands
  assert.equal(r.checkCardResolved(card, spend('2026-08-28', 'approaching'), NOW), false);
  // same month, back on track -> resolves
  assert.equal(r.checkCardResolved(card, spend('2026-08-28', 'on track'), NOW), true);
  // same month, budget cleared (state null) -> resolves
  assert.equal(r.checkCardResolved(card, spend('2026-08-28', null), NOW), true);
  // month rolled past the card's month -> resolves (that month is closed)
  assert.equal(r.checkCardResolved(card, spend('2026-09-01', 'over budget'), NOW), true);
  // no spend slice -> left alone (stands)
  assert.equal(r.checkCardResolved(card, {}, NOW), false);
});

test('buildSpendSnapshot slice shape (empty DB is an all-quiet reading)', async () => {
  const { buildSpendSnapshot } = await import('../server/spendSnapshot.ts');
  const slice = buildSpendSnapshot(NOW);
  assert.match(slice.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof slice.anomaly.flagged, 'boolean');
  assert.equal(typeof slice.anomaly.escalated, 'boolean');
  assert.equal(typeof slice.anomaly.includesLaneC, 'boolean');
  assert.ok(Array.isArray(slice.anomaly.dimensionFlags));
  assert.ok(Array.isArray(slice.flaggedDays));
  assert.equal(slice.anomaly.flagged, false); // no sessions -> nothing flags
  // CHI-366: the slice always carries a budget posture; with no budget configured
  // its state is null (the briefing then emits no budget card).
  assert.equal(typeof slice.budget.monthToDate, 'number');
  assert.equal(slice.budget.state, null);
});

// ---- routes ----
let server, baseUrl;
before(async () => {
  const app = express();
  app.use(express.json());
  mountBriefing(app);
  await new Promise((res) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; res(); }); });
});
after(async () => { if (server) await new Promise((res) => server.close(res)); delete process.env.CHRONICLE_DEMO; });

test('GET /briefing (demo) returns the demo cards; POST /action updates state', async () => {
  process.env.CHRONICLE_DEMO = '1';
  try {
    const body = await (await fetch(`${baseUrl}/briefing`)).json();
    assert.ok(body.cards.length >= 2);
    const id = body.cards.find((c) => c.state === 'open').id;
    const res = await fetch(`${baseUrl}/briefing/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cardId: id, action: 'done' }) });
    const after = await res.json();
    assert.equal(after.cards.find((c) => c.id === id).state, 'done');
  } finally { delete process.env.CHRONICLE_DEMO; }
});

test('POST /briefing/run is refused in demo (409)', async () => {
  process.env.CHRONICLE_DEMO = '1';
  try {
    const res = await fetch(`${baseUrl}/briefing/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 409);
  } finally { delete process.env.CHRONICLE_DEMO; }
});
