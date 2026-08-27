// CHI-324 2a / D6: the new Explore dimensions `mcp` (per-MCP-server, finishing
// the dormant contract_message_metrics.mcp_server column) and `provider`
// (model vendor, distinct from `source`'s tool vendor).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTempDb } from './helpers.mjs';

let dbModule, teardown, explore;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule; teardown = temp.teardown;
  explore = await import('../server/explore.ts');
  const { upsertProject, replaceSession } = dbModule;
  const p = upsertProject('/tmp/proj-mcp');
  // One session: two assistant turns (one claude, one gpt) + two MCP tool_use
  // calls to different servers + one non-MCP tool call.
  replaceSession(
    { id: 'sm', project_id: p.id, source: 'claude-code', file_path: '/tmp/sm.jsonl',
      started_at: '2026-08-10T10:00:00.000Z', ended_at: '2026-08-10T10:30:00.000Z',
      usage: JSON.stringify({ 'claude-sonnet-5': { input: 1000, output: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }) },
    [
      { kind: 'user', text: 'go', ts: '2026-08-10T10:00:00.000Z' },
      { kind: 'assistant', model: 'claude-sonnet-5', input_tokens: 100, output_tokens: 50, text: 'a', ts: '2026-08-10T10:01:00.000Z' },
      { kind: 'assistant', model: 'gpt-5.6-terra', input_tokens: 40, output_tokens: 20, text: 'b', ts: '2026-08-10T10:02:00.000Z' },
      { kind: 'tool_use', tool_name: 'mcp__github__search_issues', tool_use_id: 'g1', tool_input: 'query text here', ts: '2026-08-10T10:03:00.000Z' },
      { kind: 'tool_use', tool_name: 'mcp__linear__list_issues', tool_use_id: 'l1', tool_input: 'other query', ts: '2026-08-10T10:04:00.000Z' },
      { kind: 'tool_use', tool_name: 'Bash', tool_use_id: 'b1', tool_input: 'ls', ts: '2026-08-10T10:05:00.000Z' },
    ],
  );
});
after(async () => { await teardown?.(); });

test("group='mcp' derives the server from mcp__server__tool and excludes non-MCP tools", async () => {
  const r = await explore.computeExplore({ metric: 'requests', group: 'mcp', scope: { type: 'all' }, days: null, rollup: 'total' });
  const keys = r.rows.map((x) => x.key).sort();
  assert.deepEqual(keys, ['github', 'linear']); // Bash (non-MCP) is excluded
});

test("group='provider' maps the model id to its vendor (anthropic/openai), not the tool vendor", async () => {
  const r = await explore.computeExplore({ metric: 'requests', group: 'provider', scope: { type: 'all' }, days: null, rollup: 'total' });
  const keys = r.rows.map((x) => x.key).sort();
  assert.deepEqual(keys, ['anthropic', 'openai']); // claude → anthropic, gpt-5.6 → openai
});

test("group='mcp' with the spend metric is calibrated (tokens estimated from tool_use text share)", async () => {
  const r = await explore.computeExplore({ metric: 'tokens', group: 'mcp', scope: { type: 'all' }, days: null, rollup: 'total' });
  assert.equal(r.calibrated, true);
  // both servers placed, tokens > 0 (calibrated share of the billed total)
  assert.equal(r.rows.length, 2);
  assert.ok(r.rows.every((x) => x.tokensByModel && Object.keys(x.tokensByModel).length > 0));
});
