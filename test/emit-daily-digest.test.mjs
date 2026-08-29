// Pins for the satellite daily-digest emitter (CHI-398).
//
// AIOS_HUB is set to a fresh temp dir for EVERY call into the emitter here --
// this suite must never write into the real hub's records/spool/chronicle/.
// (no-ambient-hub.mjs already clears any ambient AIOS_HUB/CHRONICLE_HUB before
// this file runs, so a bare `main()` with no override would resolve to the
// hardcoded ~/chizhang-2 fallback -- every test below overrides it explicitly.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { main, buildPayload, resolveHub } = await import('../scripts/emit-daily-digest.ts');

function tmpHub() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-digest-hub-'));
}

test('resolveHub: AIOS_HUB env wins when set and non-empty', () => {
  const prev = process.env.AIOS_HUB;
  try {
    process.env.AIOS_HUB = '/tmp/some-hub';
    assert.equal(resolveHub(), '/tmp/some-hub');
    process.env.AIOS_HUB = '';
    assert.equal(resolveHub(), path.join(os.homedir(), 'chizhang-2'));
    delete process.env.AIOS_HUB;
    assert.equal(resolveHub(), path.join(os.homedir(), 'chizhang-2'));
  } finally {
    if (prev === undefined) delete process.env.AIOS_HUB;
    else process.env.AIOS_HUB = prev;
  }
});

test('main: writes exactly one valid artifact under <hub>/records/spool/chronicle/', () => {
  const hub = tmpHub();
  const prev = process.env.AIOS_HUB;
  process.env.AIOS_HUB = hub;
  try {
    const code = main(new Date('2026-08-29T12:00:00'));
    assert.equal(code, 0);

    const dir = path.join(hub, 'records', 'spool', 'chronicle');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, 'exactly one artifact written');

    const raw = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
    const payload = JSON.parse(raw); // must be valid JSON

    // exact required-key set, no more, no less
    assert.deepEqual(new Set(Object.keys(payload)), new Set(['repo', 'date', 'needs_you', 'auto_done', 'health']));

    assert.equal(payload.repo, 'chronicle');
    assert.equal(typeof payload.date, 'string');
    assert.match(payload.date, /^\d{4}-\d{2}-\d{2}$/);

    assert.ok(Array.isArray(payload.needs_you));
    for (const item of payload.needs_you) assert.equal(typeof item, 'string');

    assert.equal(typeof payload.auto_done, 'object');
    assert.ok(!Array.isArray(payload.auto_done));
    for (const [k, v] of Object.entries(payload.auto_done)) {
      assert.equal(typeof k, 'string');
      assert.equal(typeof v, 'number');
      assert.ok(Number.isInteger(v), `auto_done.${k} must be an integer, got ${v}`);
    }

    assert.ok(Array.isArray(payload.health));
    assert.ok(payload.health.length >= 1, 'health must be non-empty');
    for (const line of payload.health) assert.equal(typeof line, 'string');
  } finally {
    if (prev === undefined) delete process.env.AIOS_HUB;
    else process.env.AIOS_HUB = prev;
    fs.rmSync(hub, { recursive: true, force: true });
  }
});

test('main: filename is <date>-<8 hex chars>.json and the write is atomic (no leftover .tmp)', () => {
  const hub = tmpHub();
  const prev = process.env.AIOS_HUB;
  process.env.AIOS_HUB = hub;
  try {
    const now = new Date('2026-08-29T12:00:00');
    main(now);
    const dir = path.join(hub, 'records', 'spool', 'chronicle');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^2026-08-29-[0-9a-f]{8}\.json$/);
    assert.ok(!files.some((f) => f.endsWith('.tmp')), 'no leftover .tmp file after an atomic write');
  } finally {
    if (prev === undefined) delete process.env.AIOS_HUB;
    else process.env.AIOS_HUB = prev;
    fs.rmSync(hub, { recursive: true, force: true });
  }
});

test('buildPayload: needs_you is empty (no floor condition this emitter can detect), auto_done counts are ints', () => {
  const { needsYou, autoDone } = buildPayload(new Date());
  assert.deepEqual(needsYou, []);
  for (const v of Object.values(autoDone)) assert.ok(Number.isInteger(v));
});
