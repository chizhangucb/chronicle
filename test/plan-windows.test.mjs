// CHI-324 2f: the Claude plan-windows payload parser (pure — no outbound). Reads
// Anthropic's `limits` array (the clean labeled source: session / weekly_all /
// weekly_scoped-with-model-display_name). Pins the shape so a contract change
// fails loudly, and that the top-tier label follows the API's display_name
// ("Fable"), never a hardcoded model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudePayload } from '../server/planWindows.ts';

test('parseClaudePayload maps session→5h, weekly_all→7d, weekly_scoped→model display_name', () => {
  const a = parseClaudePayload({
    subscription_type: 'max',
    limits: [
      { kind: 'session', percent: 8, resets_at: '2026-08-27T19:40:00Z' },
      { kind: 'weekly_all', percent: 13, resets_at: '2026-08-28T08:00:00Z' },
      { kind: 'weekly_scoped', percent: 7, resets_at: '2026-08-28T08:00:00Z', scope: { model: { display_name: 'Fable' } } },
    ],
  });
  assert.ok(a);
  assert.equal(a.kind, 'claude');
  assert.equal(a.plan, 'max');
  assert.deepEqual(a.windows.map((w) => w.label), ['5h', '7d', 'Fable']);
  assert.equal(a.windows[2].utilization, 7);
  assert.equal(a.windows[0].resetsAt, '2026-08-27T19:40:00Z');
});

test('parseClaudePayload skips unknown/percent-less entries but keeps the known ones', () => {
  const a = parseClaudePayload({ limits: [
    { kind: 'session', percent: 5, resets_at: null },
    { kind: 'nimbus_quill', percent: 0, resets_at: null },          // unknown kind, no model scope → skipped
    { kind: 'weekly_all', resets_at: null },                        // no numeric percent → skipped
  ] });
  assert.deepEqual(a.windows.map((w) => w.label), ['5h']);
});

test('parseClaudePayload rejects a payload with no recognizable window', () => {
  assert.equal(parseClaudePayload({ limits: [] }), null);
  assert.equal(parseClaudePayload({ foo: 1 }), null);
  assert.equal(parseClaudePayload(null), null);
});
