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
