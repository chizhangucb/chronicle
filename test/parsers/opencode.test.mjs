import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scanOpencodeProjects, parseOpencodeSessions } from '../../server/parsers/opencode.ts';

const FIXTURE = 'test/fixtures/oc-live.db';

test('scanOpencodeProjects: finds the fixture session, grouped by directory', () => {
  const before = fs.statSync(FIXTURE);

  const projects = scanOpencodeProjects(FIXTURE);

  const after = fs.statSync(FIXTURE);
  assert.equal(after.mtimeMs, before.mtimeMs, 'scan must not touch the source DB mtime');
  assert.equal(after.size, before.size, 'scan must not touch the source DB size');

  assert.equal(projects.length, 1);
  const [project] = projects;
  assert.equal(project.source, 'opencode');
  assert.equal(project.logDir, FIXTURE);
  assert.equal(project.directory, '/tmp/oc-live-project');
  assert.equal(project.name, 'oc-live-project');
  assert.equal(project.physicalPath, '/tmp/oc-live-project');
  assert.equal(project.sessionCount, 1);
  // COUNT(m.id) over the `message` table (2 rows: 1 user, 1 assistant) — NOT
  // the flattened event count produced by parseOpencodeSessions (which is 4,
  // since one `tool` part expands into a tool_use + tool_result pair).
  assert.equal(project.messageEstimate, 2);

  const [session] = project.sessions;
  assert.equal(session.id, 'ses_live1');
  assert.equal(session.label, 'Live test');
  assert.equal(session.messageEstimate, 2);
  assert.equal(session.modifiedAt, '2026-07-04T08:57:26.884Z');
});

test('parseOpencodeSessions: session envelope pins id, cwd, timestamps, first prompt', () => {
  const before = fs.statSync(FIXTURE);

  const parsed = parseOpencodeSessions(FIXTURE, '/tmp/oc-live-project', ['ses_live1']);

  const after = fs.statSync(FIXTURE);
  assert.equal(after.mtimeMs, before.mtimeMs, 'parse must not touch the source DB mtime');
  assert.equal(after.size, before.size, 'parse must not touch the source DB size');

  assert.equal(parsed.length, 1);
  const { session } = parsed[0];
  assert.equal(session.id, 'oc-ses_live1');
  assert.equal(session.source, 'opencode');
  assert.equal(session.file_path, FIXTURE);
  assert.equal(session.cwd, '/tmp/oc-live-project');
  assert.equal(session.first_prompt, 'initial message');
  assert.equal(session.skipped, 0);
  assert.equal(session.started_at, '2026-07-04T08:57:26.884Z');

  // BUG (see report): ended_at is read straight off session.time_updated
  // (opencode.js:110), which in this fixture was never bumped past the
  // session's creation time — so ended_at pins EARLIER than the last event's
  // own ts (2026-07-04T08:58:40.714Z, the tool_result below), even though the
  // session clearly kept going after time_created. Asserting the current,
  // observed (buggy) value here, not a "fixed" one.
  assert.equal(session.ended_at, '2026-07-04T08:57:26.884Z');
});

test('parseOpencodeSessions: flattens parts into the normalized kind set, in order', () => {
  const parsed = parseOpencodeSessions(FIXTURE, '/tmp/oc-live-project', ['ses_live1']);
  const { events } = parsed[0];

  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['user', 'assistant', 'tool_use', 'tool_result'],
  );

  const [userEvt, assistantEvt, toolUseEvt, toolResultEvt] = events;

  assert.equal(userEvt.text, 'initial message');
  assert.equal(userEvt.model, null);

  assert.equal(assistantEvt.text, 'LIVE POLLED REPLY arrives!');
  assert.equal(assistantEvt.model, 'test-model');

  // A single `tool` part expands into a tool_use/tool_result pair sharing the
  // part's own timestamp and callID.
  assert.equal(toolUseEvt.tool_name, 'bash');
  assert.equal(toolUseEvt.tool_use_id, 'c1');
  assert.equal(toolUseEvt.tool_input, '{"command":"ls"}');
  assert.equal(toolUseEvt.model, 'test-model');

  assert.equal(toolResultEvt.tool_use_id, toolUseEvt.tool_use_id);
  assert.equal(toolResultEvt.text, 'ok');

  // First/last event timestamps are sane and monotonic.
  const firstTs = new Date(events[0].ts).getTime();
  const lastTs = new Date(events[events.length - 1].ts).getTime();
  assert.ok(firstTs <= lastTs);
  assert.equal(events[0].ts, '2026-07-04T08:57:26.884Z');
  assert.equal(events[events.length - 1].ts, '2026-07-04T08:58:40.714Z');
});

test('parseOpencodeSessions: sessionIds filter excludes non-matching sessions', () => {
  const parsed = parseOpencodeSessions(FIXTURE, '/tmp/oc-live-project', ['does-not-exist']);
  assert.equal(parsed.length, 0);
});

test('parseOpencodeSessions: no thinking events or token usage fields in this fixture', () => {
  const parsed = parseOpencodeSessions(FIXTURE, '/tmp/oc-live-project', ['ses_live1']);
  const { events } = parsed[0];

  // The fixture's single `message` rows carry no reasoning parts and no
  // usage/token fields at all (the raw `message.data` JSON has only
  // `role`/`modelID`); the parser never reads or emits token usage for
  // OpenCode. Documenting the absence rather than inventing coverage.
  assert.ok(!events.some((e) => e.kind === 'thinking'));
  for (const e of events) {
    assert.equal(e.input_tokens, undefined);
    assert.equal(e.output_tokens, undefined);
    assert.equal(e.usage, undefined);
  }
});
