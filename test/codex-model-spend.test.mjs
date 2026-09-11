// Codex spend is visible end to end (#198): a Codex transcript imported the way
// the import route imports it lands a real model on its assistant rows, and the
// tokens behind those rows reach the Spend tab's provider stack as `openai`
// dollars instead of an unpriceable NULL.
//
// Driven through the seams a caller uses — the Source's own parse, the import
// route's importParsed, the Insights engine, and the client-side aggregation
// the Spend tab charts read — never through parser internals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withTempDb } from './helpers.mjs';
import { providerOf, PROVIDER_ORDER } from '../shared/provider.ts';
import { costOf, isSubscriptionCovered, pricingFor } from '../shared/pricing.ts';
import { sumByModel, costOfCells, groupByKey } from '../src/rangedUsage.ts';

const MODEL = 'gpt-5-codex';
const CWD = '/tmp/codex-spend-project';

// Six turns, each ending in the token_count line Codex writes for the API call
// that produced it — enough messages to clear the noise gate, so the session
// lands in the main ledger the Insights engine reads.
function writeRollout(dir) {
  const at = (min) => new Date(Date.now() - (90 - min) * 60_000).toISOString();
  const lines = [
    { timestamp: at(0), type: 'session_meta', payload: { id: 'spend-198', cwd: CWD } },
    { timestamp: at(1), type: 'turn_context', payload: { cwd: CWD, model: MODEL, effort: 'medium' } },
  ];
  for (let i = 0; i < 6; i++) {
    const base = 2 + i * 10;
    lines.push({ timestamp: at(base), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `task ${i}` }] } });
    lines.push({ timestamp: at(base + 1), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `done ${i}` }] } });
    lines.push({ timestamp: at(base + 2), type: 'token_count', payload: { info: { last_token_usage: { input_tokens: 1_100_000, output_tokens: 100_000, cached_input_tokens: 100_000, cache_write_input_tokens: 0 } } } });
  }
  const file = path.join(dir, 'rollout-2026-09-01T09-00-00-spend.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

let dbModule, teardown, tmpDir, insights, scope, importSync;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  importSync = await import('../server/routes/import-sync.ts');
  insights = await import('../server/insights.ts');
  scope = await import('../server/scope.ts');

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-codex-spend-'));
  writeRollout(tmpDir);
  const parsed = await importSync.gatherParsed({ source: 'codex', logDir: tmpDir });
  const result = importSync.importParsed(parsed);
  assert.equal(result.imported, 1, 'fixture must import as one session');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  teardown();
});

test('an imported Codex session has a real model on its assistant rows, not NULL', () => {
  // The acceptance query from the ticket, verbatim in shape: what a reader of
  // chronicle.db sees after a re-import.
  const rows = dbModule.db.prepare(`
    SELECT model, COUNT(*) AS n FROM messages m JOIN sessions s ON s.id = m.session_id
    WHERE s.source = 'codex' AND m.kind = 'assistant' GROUP BY model
  `).all().map((r) => ({ model: r.model, n: r.n }));

  assert.deepEqual(rows, [{ model: MODEL, n: 6 }]);
  assert.equal(providerOf(rows[0].model), 'openai');
});

test('the Spend tab provider stack shows an openai series for Codex spend', async () => {
  const result = await insights.computeInsights({ type: 'all' }, scope.rangeOf(7));

  // SpendOverTime's own [provider] stack: the vendors present in range, in the
  // fixed categorical order, keyed off each cell's model.
  const present = new Set(result.rangedTokensByModel.map((c) => providerOf(c.model)));
  const series = PROVIDER_ORDER.filter((p) => present.has(p));
  assert.deepEqual(series, ['openai']);

  // And the series carries real dollars, not the $0 stack an unpriceable NULL
  // model produced (the figure itself is the price table's business, pinned in
  // test/models.test.mjs — this asserts the tokens reach it at all).
  const byProvider = groupByKey(result.rangedTokensByModel, (c) => providerOf(c.model));
  const openaiSpend = costOfCells(sumByModel(byProvider.get('openai')));
  assert.ok(openaiSpend > 0, `expected nonzero openai spend, got ${openaiSpend}`);
});

test('Codex tokens are subscription-covered, not silently free: list price > 0, billed 0', async () => {
  const result = await insights.computeInsights({ type: 'all' }, scope.rangeOf(7));
  const [cell] = result.rangedTokensByModel;

  // Explicitly covered rather than unpriced: an unpriced model has no price
  // table entry at all and would read $0 in BOTH bases with nothing saying why.
  assert.ok(pricingFor(cell.model), 'the imported Codex model must be in the price table');
  assert.equal(isSubscriptionCovered(cell.model), true);
  assert.ok(costOf(cell.model, cell.cells, null, 'theoretical') > 0);
  assert.equal(costOf(cell.model, cell.cells, null, 'real'), 0);
});
