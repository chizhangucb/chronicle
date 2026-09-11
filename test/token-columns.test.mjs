import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSource } from './helpers/read-source.mjs';
import { detailTokensCell, cardTokenMarker } from '../src/explore/tokenColumns.ts';

// The formatter the Detail table passes in (ExploreTab's fmtTok), stubbed with
// a shape the assertions can read at a glance.
const fmt = (n) => `${n}t`;

// The Detail Tokens column shows a concrete number for every group whose token
// magnitude is a real count: model/project/source/session (billed cells from
// sessions.usage) and subagent/hour (per-message columns). It shows it MARKED
// for the partial ones, because those columns hold only ~0.73 of billed usage
// (server/explore.ts EXACT_USAGE_GROUPS) and the figure would otherwise read
// as the whole bill (#203).
test('detailTokensCell: partial groups carry ≈, exact groups do not (#203)', () => {
  assert.equal(detailTokensCell('hour', 1_200_000, fmt), '≈1200000t');
  assert.equal(detailTokensCell('subagent', 840_000, fmt), '≈840000t');
  assert.equal(detailTokensCell('model', 1_200_000, fmt), '1200000t');
  assert.equal(detailTokensCell('project', 1_200_000, fmt), '1200000t');
  assert.equal(detailTokensCell('source', 1_200_000, fmt), '1200000t');
  assert.equal(detailTokensCell('session', 1_200_000, fmt), '1200000t');
});

// tool/skill are calibrated: token magnitude is attributed from message-text
// length (ADR 0006), so the Detail Tokens column suppresses to `—` (EXP-02)
// rather than restating that figure next to real Requests/Sessions. Note
// $/session is NOT gated with it: that cell is spend-derived and shows for
// every group.
test('detailTokensCell: calibrated groups suppress Tokens to — (EXP-02)', () => {
  assert.equal(detailTokensCell('tool', 1_200_000, fmt), '—');
  assert.equal(detailTokensCell('skill', 1_200_000, fmt), '—');
  assert.equal(detailTokensCell('mcp', 1_200_000, fmt), '—');
});

// A row with no per-message tokens at all (cursor and opencode write none) is
// not a partial figure, it is a zero. Marking it ≈ would claim a shortfall
// against nothing.
test('detailTokensCell: a zero row is shown bare, not marked (#203)', () => {
  assert.equal(detailTokensCell('hour', 0, fmt), '0t');
  assert.equal(detailTokensCell('subagent', 0, fmt), '0t');
});

// #203. The card's `≈` is the one signal that says "not a billed total". The
// server only knows about the text-share calibration (tool/skill/mcp), so the
// client adds the partial groups on the same rule the server uses for its own
// flag: only when the displayed metric reads token magnitude, so switching to
// Requests or Errors does not sprinkle ≈ over counts.
test('cardTokenMarker: partial groups earn ≈ under token-reading metrics (#203)', () => {
  assert.equal(cardTokenMarker('hour', 'tokens', false).show, true);
  assert.equal(cardTokenMarker('hour', 'spend', false).show, true);
  assert.equal(cardTokenMarker('subagent', 'tokens', false).show, true);
  assert.equal(cardTokenMarker('subagent', 'requests', false).show, false);
  assert.equal(cardTokenMarker('hour', 'errors', false).show, false);
  assert.equal(cardTokenMarker('hour', 'sessions', false).show, false);
});

test('cardTokenMarker: exact groups never earn it, calibrated groups keep the server flag', () => {
  assert.equal(cardTokenMarker('model', 'tokens', false).show, false);
  assert.equal(cardTokenMarker('project', 'spend', false).show, false);
  assert.equal(cardTokenMarker('session', 'tokens', false).show, false);
  // the server sets calibrated for tool/skill/mcp × tokens|spend, honored verbatim
  assert.equal(cardTokenMarker('tool', 'tokens', true).show, true);
  assert.equal(cardTokenMarker('tool', 'requests', false).show, false);
});

// One marker, one meaning: this is not a billed total. The ⓘ next to it says
// which kind of figure it is, so the two causes point at their own definition.
test('cardTokenMarker: each kind carries its own registry definition (#203)', () => {
  assert.equal(cardTokenMarker('tool', 'tokens', true).def, 'spend.token-attribution');
  assert.equal(cardTokenMarker('hour', 'tokens', false).def, 'explore.partial-tokens');
  assert.equal(cardTokenMarker('subagent', 'spend', false).def, 'explore.partial-tokens');
});

// The card and the Detail table must never disagree about whether a group's
// tokens are the whole bill: wherever the Detail cell shows a number, its
// marker matches the one the card carries under the Tokens metric.
test('card and Detail table agree on the ≈ signal for every group (#203)', () => {
  for (const group of ['model', 'project', 'source', 'session', 'subagent', 'hour', 'provider']) {
    const card = cardTokenMarker(group, 'tokens', false).show;
    const cell = detailTokensCell(group, 1_200_000, fmt);
    assert.notEqual(cell, '—', `${group} shows a real number`);
    assert.equal(cell.startsWith('≈'), card, `${group} cell vs card`);
  }
});

// #203. The badge's ⓘ has to be able to answer "part of what?" for the
// per-message groups, which the calibration definition does not cover.
test('the partial-token marker resolves to a definition that says the figure is part of the bill (#203)', async () => {
  const { DEF_BY_ID } = await import('../src/reference/definitions.ts');
  // ExploreTab passes `def` through as an expression, which reference-registry's
  // `def="..."` literal scan cannot see, so every id this function can hand out
  // is resolved here instead, or the marker would open a blank bubble.
  for (const g of ['hour', 'subagent', 'provider', 'tool', 'skill', 'mcp']) {
    const calibrated = g === 'tool' || g === 'skill' || g === 'mcp';
    const id = cardTokenMarker(g, 'tokens', calibrated).def;
    assert.ok(DEF_BY_ID.has(id), `${g}'s ≈ points at a missing definition: ${id}`);
  }
  const def = DEF_BY_ID.get(cardTokenMarker('hour', 'tokens', false).def);
  assert.equal(def.page, 'explore');
  const plain = def.plain({});
  assert.match(plain, /≈/, 'the definition names the marker it explains');
  assert.match(plain, /part of what was billed/i, 'it says the figure is not the whole bill');
  assert.match(plain, /Hour and Subagent/, 'it names the dimensions that carry it');
});

// Anti-drift pin. Which groups are partial is decided ONCE, in tokenColumns.ts;
// the surface must not re-derive it inline (the drift #203 fixes was exactly a
// Detail table whose own rule disagreed with the card's).
test('ExploreTab takes both markers from this module (#203)', () => {
  const src = readSource(new URL('../src/ExploreTab.tsx', import.meta.url).pathname);
  assert.match(src, /detailTokensCell\(/, 'the Detail Tokens cell goes through detailTokensCell');
  assert.match(src, /cardTokenMarker\(/, 'the card marker goes through cardTokenMarker');
});
