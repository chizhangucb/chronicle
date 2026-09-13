// One SSE watcher base behind two adapters (issue #379).
//
// Both live watchers used to carry the same scaffolding: the connected-client
// set, broadcast, addClient/removeClient, the idle-poll-interval bookkeeping
// and close were written twice, once for the JSONL tail and once for the
// SQLite poll. Two copies is two places for the idle step-down or the
// auto-stop to drift. The scaffolding now lives in one base
// (server/liveWatchers.ts) and each watcher supplies only how it gets new
// events: read what was appended to a transcript, or re-parse a store and
// diff it.
//
// The base is driven here through a scripted adapter — it is the seam the two
// real adapters sit on — and then both real ones are driven end to end
// through attachLiveStream(), the way a browser opening an SSE stream drives
// them. Timers and the clock are mocked so the 2-minute idle step-down is
// asserted without a 2-minute test.
import { test, describe, before, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionWatcher, openWatchers } from '../server/liveWatchers.ts';
import { withTempDb } from './helpers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures');

// The SSE response object, reduced to what a watcher actually uses.
function fakeRes() {
  return {
    writes: [],
    ended: false,
    headers: null,
    writeHead(_code, headers) { this.headers = headers; },
    write(data) { this.writes.push(data); return true; },
    end() { this.ended = true; },
    on(event, fn) { if (event === 'close') this.closeHandler = fn; },
  };
}

// The payloads a client has been sent so far, parsed back out of the SSE frames.
function sent(res) {
  return res.writes.map((w) => JSON.parse(w.replace(/^data: /, '').trim()));
}

// Real timers would make the idle step-down a 2-minute wait; Date goes with
// them because the watcher times its silence off the wall clock.
function fakeClock() {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
}

// Let whatever the tick started (a transcript read, a store re-parse) actually
// finish: those are real I/O, which the mocked timers do not hold up. Only
// setInterval is mocked, so a real setTimeout still turns the event loop.
async function settle() {
  for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0));
}

async function tick(ms) {
  mock.timers.tick(ms);
  await settle();
}

// Wait for a read the tick kicked off to land, rather than for a fixed number
// of turns: a loaded machine takes longer to open a file than an idle one.
async function until(predicate, what) {
  for (let i = 0; i < 500 && !predicate(); i++) await new Promise((r) => setTimeout(r, 4));
  assert.ok(predicate(), `timed out waiting for ${what}`);
}

afterEach(() => { mock.timers.reset(); });

describe('the watcher base', () => {
  // An adapter that fetches from a script instead of a file: one `feed()` is
  // one write to whatever this watcher is watching.
  class ScriptedWatcher extends SessionWatcher {
    constructor(sessionId, cadence) {
      super(sessionId, cadence, 0);
      this.writes = 0;
      this.batches = [];
      this.gone = false;
    }
    feed(events) { this.batches.push(events); this.writes++; }
    revision() { return this.gone ? null : this.writes; }
    async fetchNewEvents() { return this.batches.shift() ?? []; }
    opening() { return { watching: 'scripted' }; }
  }

  const CADENCE = { activeMs: 700, idleMs: 3000, idleAfterMs: 120000 };
  const made = [];
  function scripted(sessionId, cadence = CADENCE) {
    const w = new ScriptedWatcher(sessionId, cadence);
    made.push(w);
    return w;
  }
  afterEach(() => {
    while (made.length) made.pop().close('test over');
  });

  test('a client joining is told the session is live, and then gets each batch of new events', async () => {
    fakeClock();
    const watcher = scripted('s_scripted_1');
    const res = fakeRes();
    watcher.addClient(res);

    assert.deepEqual(sent(res), [{ type: 'status', status: 'live', watching: 'scripted' }]);

    watcher.feed([{ kind: 'user', text: 'first' }]);
    await tick(700);
    watcher.feed([{ kind: 'assistant', text: 'second' }]);
    await tick(700);

    assert.deepEqual(sent(res).slice(1), [
      { type: 'messages', events: [{ kind: 'user', text: 'first', seq: 1000000 }] },
      { type: 'messages', events: [{ kind: 'assistant', text: 'second', seq: 1000001 }] },
    ]);
  });

  test('a poll that finds nothing new sends nothing', async () => {
    fakeClock();
    const watcher = scripted('s_scripted_2');
    const res = fakeRes();
    watcher.addClient(res);
    await tick(700 * 5);
    assert.equal(sent(res).length, 1);
  });

  test('every joined client gets the same batch, and one that can no longer be written to is dropped', async () => {
    fakeClock();
    const watcher = scripted('s_scripted_3');
    const good = fakeRes();
    const broken = fakeRes();
    broken.write = () => { throw new Error('socket gone'); };
    watcher.addClient(good);
    try { watcher.addClient(broken); } catch {}

    watcher.feed([{ kind: 'user', text: 'to both' }]);
    await tick(700);

    assert.deepEqual(sent(good).slice(1), [
      { type: 'messages', events: [{ kind: 'user', text: 'to both', seq: 1000000 }] },
    ]);
    assert.equal(watcher.status().clients, 1, 'the client that threw is no longer written to');
  });

  test('the last client leaving stops the watcher, which then no longer counts as open', async () => {
    fakeClock();
    const watcher = scripted('s_scripted_4');
    const first = fakeRes();
    const second = fakeRes();
    watcher.addClient(first);
    watcher.addClient(second);

    watcher.removeClient(first);
    assert.ok(openWatchers().has('s_scripted_4'), 'one client left, so the watcher stays open');

    // A client that has left is a closed connection, so it is dropped before
    // the stop rather than written to: the watcher simply goes away.
    watcher.removeClient(second);
    assert.equal(openWatchers().has('s_scripted_4'), false);
    assert.equal(sent(second).length, 1);
    watcher.feed([{ kind: 'user', text: 'nobody is listening' }]);
    await tick(700);
    assert.equal(sent(second).length, 1, 'a stopped watcher polls nothing');
  });

  test('a session whose file has gone stops the watcher and says so', async () => {
    fakeClock();
    const watcher = scripted('s_scripted_5');
    const res = fakeRes();
    watcher.addClient(res);
    watcher.gone = true;
    await tick(700);

    assert.deepEqual(sent(res).slice(1), [{ type: 'status', status: 'stopped', reason: 'file gone' }]);
    assert.equal(openWatchers().has('s_scripted_5'), false);
  });

  test('two minutes of silence steps the poll down, and the next write steps it back up', async () => {
    fakeClock();
    const watcher = scripted('s_scripted_6');
    const res = fakeRes();
    watcher.addClient(res);

    // Silent for longer than the idle threshold: the poll is now the slow one.
    await tick(121000);
    watcher.feed([{ kind: 'user', text: 'after the quiet' }]);
    await tick(700);
    assert.equal(sent(res).length, 1, 'the fast poll is no longer running');
    await tick(2300);
    assert.deepEqual(sent(res).slice(1), [
      { type: 'messages', events: [{ kind: 'user', text: 'after the quiet', seq: 1000000 }] },
    ]);

    // That write made the session active again, so the fast poll is back.
    watcher.feed([{ kind: 'assistant', text: 'still here' }]);
    await tick(700);
    assert.deepEqual(sent(res).slice(2), [
      { type: 'messages', events: [{ kind: 'assistant', text: 'still here', seq: 1000001 }] },
    ]);
  });
});

// ---- The two real adapters, end to end through attachLiveStream ----

let dbModule, teardown, attachLiveStream, liveStatus, tmp;

before(async () => {
  const temp = await withTempDb();
  dbModule = temp.dbModule;
  teardown = temp.teardown;
  ({ attachLiveStream, liveStatus } = await import('../server/live.ts'));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-live-watchers-'));
});

after(() => {
  for (const w of [...openWatchers().values()]) w.close('test over');
  teardown?.();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function claudeLine(uuid, text, ts) {
  return JSON.stringify({
    type: 'user', sessionId: 's_tail', cwd: '/tmp/tailed', uuid,
    timestamp: ts, message: { role: 'user', content: text },
  }) + '\n';
}

describe('a JSONL-tailed session', () => {
  test('streams each appended line to its client, and stops when the client leaves', async () => {
    const file = path.join(tmp, 'tailed.jsonl');
    fs.writeFileSync(file, claudeLine('u0', 'already stored', '2026-09-13T10:00:00.000Z'));
    const project = dbModule.upsertProject('/tmp/tailed');
    dbModule.replaceSession({
      id: 's_tail', project_id: project.id, source: 'claude-code', file_path: file,
      started_at: '2026-09-13T10:00:00.000Z', ended_at: '2026-09-13T10:00:00.000Z',
    }, []);

    fakeClock();
    const res = fakeRes();
    assert.equal(attachLiveStream('s_tail', res), true);
    assert.equal(res.headers['Content-Type'], 'text/event-stream');
    assert.deepEqual(sent(res), [{ type: 'status', status: 'live', watching: file }]);

    // Only what is appended after the stream opened is live.
    fs.appendFileSync(file, claudeLine('u1', 'hello from the tail', '2026-09-13T10:01:00.000Z'));
    await tick(700);
    await until(() => sent(res).length > 1, 'the appended line to reach the client');

    const [batch] = sent(res).slice(1);
    assert.equal(batch.type, 'messages');
    assert.deepEqual(batch.events.map((e) => [e.kind, e.text, e.seq]), [['user', 'hello from the tail', 1000000]]);

    // The tail watcher reports the file it reads and how far into it it is.
    const status = liveStatus().find((w) => w.sessionId === 's_tail');
    assert.equal(status.file, file);
    assert.equal(status.offset, fs.statSync(file).size);
    assert.equal(status.clients, 1);

    // The browser hanging up is the last client leaving: the watcher stops.
    res.closeHandler();
    assert.equal(liveStatus().some((w) => w.sessionId === 's_tail'), false);
    fs.appendFileSync(file, claudeLine('u2', 'nobody is listening', '2026-09-13T10:02:00.000Z'));
    await tick(700 * 3);
    assert.equal(sent(res).length, 2, 'a stopped watcher tails nothing');
  });
});

describe('a SQLite-polled session', () => {
  test('re-parses its store on a write and streams the messages it did not have', async () => {
    const store = path.join(tmp, 'opencode.db');
    fs.copyFileSync(path.join(FIXTURES, 'oc-live.db'), store);
    const project = dbModule.upsertProject('/tmp/oc-live-project');
    dbModule.replaceSession({
      id: 'oc-ses_live1', project_id: project.id, source: 'opencode', file_path: store,
      started_at: '2026-09-13T10:00:00.000Z', ended_at: '2026-09-13T10:00:00.000Z',
    }, []);

    fakeClock();
    const res = fakeRes();
    assert.equal(attachLiveStream('oc-ses_live1', res), true);
    assert.deepEqual(sent(res), [{ type: 'status', status: 'live', watching: store, mode: 'poll' }]);

    await tick(2000);
    await until(() => sent(res).length > 1, 'the store re-parse to reach the client');

    const [batch] = sent(res).slice(1);
    assert.equal(batch.type, 'messages');
    assert.deepEqual(batch.events.map((e) => e.kind), ['user', 'assistant', 'tool_use', 'tool_result']);
    assert.deepEqual(batch.events.map((e) => e.seq), [1000000, 1000001, 1000002, 1000003]);

    // Nothing changed in the store since, so the next poll says nothing.
    await tick(2000);
    assert.equal(sent(res).length, 2);

    res.closeHandler();
    assert.equal(openWatchers().has('oc-ses_live1'), false);
  });
});

// ---- The removal half: the scaffolding has one home ----

describe('the scaffolding', () => {
  const BASE = fs.readFileSync(path.join(REPO, 'server', 'liveWatchers.ts'), 'utf8');
  const LIVE = fs.readFileSync(path.join(REPO, 'server', 'live.ts'), 'utf8');

  test('is declared once in the base, and nowhere in server/live.ts', () => {
    for (const member of ['broadcast', 'addClient', 'removeClient', 'close', 'setPollInterval']) {
      const declared = BASE.match(new RegExp(`^\\s{2}(?:private |protected )?(?:async )?${member}\\(`, 'gm')) ?? [];
      assert.equal(declared.length, 1, `${member}() should be declared once, on the base`);
      assert.equal(new RegExp(`^\\s+(?:private |protected )?(?:async )?${member}\\(`, 'm').test(LIVE), false,
        `server/live.ts should not declare ${member}() any more`);
    }
  });

  test('leaves each adapter only its fetch-new-events step', () => {
    const adapters = BASE.match(/^class \w+ extends SessionWatcher \{[\s\S]*?^\}/gm) ?? [];
    assert.equal(adapters.length, 2, 'two adapters: the JSONL tail and the SQLite poll');
    for (const adapter of adapters) {
      const members = (adapter.match(/^ {2}(?:private |protected |readonly )*(?:async )?(\w+)\(/gm) ?? [])
        .map((m) => m.trim().replace(/^(?:private |protected |readonly |async )*/, '').replace(/\($/, ''));
      assert.deepEqual(members.sort(), ['constructor', 'fetchNewEvents', 'opening', 'revision'].sort(),
        'an adapter says where its events come from, and nothing else');
    }
  });
});
