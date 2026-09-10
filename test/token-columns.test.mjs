import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSource } from './helpers/read-source.mjs';
import { groupShowsTokenColumn, detailTokensCell, cardApproxBadge } from '../src/explore/tokenColumns.ts';

// The Detail Tokens column shows a concrete number for groups whose token
// magnitude the app treats as real: model/project/source (authoritative billed
// cells from sessions.usage) AND subagent/hour (per-message token columns,
// shown UNMARKED on the card/bar — server sets result.calibrated only for
// tool/skill, so `—` here would contradict the card).
test('groupShowsTokenColumn: real-number groups', () => {
  assert.equal(groupShowsTokenColumn('model'), true);
  assert.equal(groupShowsTokenColumn('project'), true);
  assert.equal(groupShowsTokenColumn('source'), true);
  assert.equal(groupShowsTokenColumn('subagent'), true);
  assert.equal(groupShowsTokenColumn('hour'), true);
});

// tool/skill are the ONLY calibrated exceptions: token magnitude is estimated
// from message-text length and the card carries the `≈` badge, so the Detail
// Tokens column suppresses to `—` (EXP-02). Note $/session is NOT gated by this
// predicate — it is spend-derived and shows for every group.
test('groupShowsTokenColumn: calibrated groups suppress Tokens to — (EXP-02)', () => {
  assert.equal(groupShowsTokenColumn('tool'), false);
  assert.equal(groupShowsTokenColumn('skill'), false);
});

// #203. hour/subagent Detail tokens are summed from per-message columns, which
// capture only ~0.73 of billed usage (server/explore.ts EXACT_USAGE_GROUPS
// comment). They stay the same number the card shows, but the cell now carries
// the same `≈` the card does, so it cannot read as a billed figure.
test('detailTokensCell: partial groups carry ≈, exact groups do not (#203)', () => {
  assert.equal(detailTokensCell('hour', '1.2M'), '≈1.2M');
  assert.equal(detailTokensCell('subagent', '840k'), '≈840k');
  assert.equal(detailTokensCell('model', '1.2M'), '1.2M');
  assert.equal(detailTokensCell('project', '1.2M'), '1.2M');
  assert.equal(detailTokensCell('source', '1.2M'), '1.2M');
});

test('detailTokensCell: calibrated groups still suppress to — (EXP-02)', () => {
  assert.equal(detailTokensCell('tool', '1.2M'), '—');
  assert.equal(detailTokensCell('skill', '1.2M'), '—');
});

// #203. The card's `≈` badge is the one signal that says "not a billed total".
// The server only knows about the text-share calibration (tool/skill/mcp), so
// the client adds the per-message groups on the same rule the server uses for
// its own flag: only when the displayed metric actually reads token magnitude,
// so switching to Requests/Errors does not sprinkle ≈ over counts.
test('cardApproxBadge: partial groups earn the badge under token-reading metrics (#203)', () => {
  assert.equal(cardApproxBadge('hour', 'tokens', false).show, true);
  assert.equal(cardApproxBadge('hour', 'spend', false).show, true);
  assert.equal(cardApproxBadge('subagent', 'tokens', false).show, true);
  assert.equal(cardApproxBadge('subagent', 'requests', false).show, false);
  assert.equal(cardApproxBadge('hour', 'errors', false).show, false);
  assert.equal(cardApproxBadge('hour', 'sessions', false).show, false);
});

test('cardApproxBadge: exact groups never earn it, calibrated groups keep the server flag', () => {
  assert.equal(cardApproxBadge('model', 'tokens', false).show, false);
  assert.equal(cardApproxBadge('project', 'spend', false).show, false);
  assert.equal(cardApproxBadge('session', 'tokens', false).show, false);
  // server sets calibrated for tool/skill/mcp × tokens|spend — honored verbatim
  assert.equal(cardApproxBadge('tool', 'tokens', true).show, true);
  assert.equal(cardApproxBadge('tool', 'requests', false).show, false);
});

// One badge, one meaning: "this is not a billed total". The ⓘ next to it says
// WHICH approximation, so the two causes point at their own definition.
test('cardApproxBadge: each cause carries its own registry definition (#203)', () => {
  assert.equal(cardApproxBadge('tool', 'tokens', true).def, 'spend.token-attribution');
  assert.equal(cardApproxBadge('hour', 'tokens', false).def, 'explore.approximate-tokens');
  assert.equal(cardApproxBadge('subagent', 'spend', false).def, 'explore.approximate-tokens');
});

// The card and the Detail table must never disagree about whether a group's
// tokens are approximate: wherever the Detail cell shows a number, its marker
// matches the badge the card carries under the Tokens metric.
test('card and Detail table agree on the approximate signal for every group (#203)', () => {
  for (const group of ['model', 'project', 'source', 'session', 'subagent', 'hour', 'provider']) {
    const badge = cardApproxBadge(group, 'tokens', false).show;
    assert.equal(groupShowsTokenColumn(group), true, `${group} shows a real number`);
    assert.equal(detailTokensCell(group, '1.2M').startsWith('≈'), badge, `${group} cell vs card`);
  }
});

// #203. The badge's ⓘ has to be able to answer "approximate how?" for the
// per-message groups, which the calibration definition does not cover.
test('the partial-token badge resolves to a definition that explains the undercount (#203)', async () => {
  const { DEF_BY_ID } = await import('../src/reference/definitions.ts');
  // ExploreTab passes `def` through as an expression, which reference-registry's
  // `def="..."` literal scan cannot see — so every id this function can hand out
  // is resolved here instead, or the badge would open a blank bubble.
  for (const g of ['hour', 'subagent', 'provider', 'tool', 'skill', 'mcp']) {
    const id = cardApproxBadge(g, 'tokens', g === 'tool' || g === 'skill' || g === 'mcp').def;
    assert.ok(DEF_BY_ID.has(id), `${g}'s ≈ badge points at a missing definition: ${id}`);
  }
  const def = DEF_BY_ID.get(cardApproxBadge('hour', 'tokens', false).def);
  assert.ok(def, 'the ≈ badge on hour/subagent points at a registry definition');
  assert.equal(def.page, 'explore');
  const plain = def.plain({});
  assert.match(plain, /≈/, 'the definition names the marker it explains');
  assert.match(plain, /under[- ]?count|less than|not the billed/i, 'it says the figure runs low');
});

// Anti-drift pin. Which groups are approximate is decided ONCE, here; the
// surface must not re-derive it inline (the drift #203 is fixing was exactly a
// Detail table whose own rule disagreed with the card's).
test('ExploreTab takes both markers from this module (#203)', () => {
  const src = readSource(new URL('../src/ExploreTab.tsx', import.meta.url).pathname);
  assert.match(src, /detailTokensCell\(/, 'the Detail Tokens cell goes through detailTokensCell');
  assert.match(src, /cardApproxBadge\(/, 'the card badge goes through cardApproxBadge');
});
