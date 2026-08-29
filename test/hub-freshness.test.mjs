// Unit pins for the hub adapter's file-state freshness infra
// (server/hub/freshness.ts). This is what replaces cache.ts for hub FILE reads:
// each slice recomputes only when its files change, heavy slices are TTL-gated,
// and the on-disk cache writes are atomic. Point CHRONICLE_DATA_DIR at a temp
// dir BEFORE import so hub-cache lands there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-fresh-data-'));
process.env.CHRONICLE_DATA_DIR = data;

const {
  pathsMaxMtimeMs,
  treeMaxMtimeMs,
  freshSlice,
  invalidateSlice,
  readHubCache,
  writeHubCache,
  hubCacheDir,
} = await import('../server/hub/freshness.ts');
const { loadConfidentialSegments } = await import('../server/hub/confidential-segments.ts');

const mk = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const touch = (p, ms) => fs.utimesSync(p, new Date(ms), new Date(ms));

test('pathsMaxMtimeMs returns the max mtime and ignores missing files', () => {
  const dir = mk('chronicle-fresh-paths-');
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  fs.writeFileSync(a, 'a'); fs.writeFileSync(b, 'b');
  touch(a, 1_000_000_000_000); touch(b, 2_000_000_000_000);
  const max = pathsMaxMtimeMs([a, b, path.join(dir, 'missing')]);
  assert.ok(Math.abs(max - 2_000_000_000_000) < 1000);
});

test('treeMaxMtimeMs prunes confidential trees (generic + declared via extraPrune) and skips symlinks', () => {
  const dir = mk('chronicle-fresh-tree-');
  fs.mkdirSync(path.join(dir, 'records'));
  fs.mkdirSync(path.join(dir, 'wiki', 'confidential'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'secret-tree'), { recursive: true });
  // The hub's private declaration names a SYNTHETIC confidential tree; the
  // loaded set is the generic `confidential` floor UNION that name.
  fs.mkdirSync(path.join(dir, 'scripts', 'egress_gate', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'scripts', 'egress_gate', 'data', 'confidential_segments.json'),
    JSON.stringify({ confidential_segments: ['secret-tree'] }),
  );
  const prune = loadConfidentialSegments(dir); // { confidential, secret-tree }

  const normal = path.join(dir, 'records', 'a.md');
  const secretGeneric = path.join(dir, 'wiki', 'confidential', 'secret.md');
  const secretDeclared = path.join(dir, 'secret-tree', 'plan.md');
  fs.writeFileSync(normal, 'x'); fs.writeFileSync(secretGeneric, 'y'); fs.writeFileSync(secretDeclared, 'z');
  touch(normal, 1_500_000_000_000);
  touch(secretGeneric, 3_000_000_000_000); // NEWER, but pruned (generic floor) — must not count
  touch(secretDeclared, 3_500_000_000_000); // NEWER, but pruned (declared) — must not count

  const max = treeMaxMtimeMs(dir, (n) => n.endsWith('.md'), prune);
  assert.ok(Math.abs(max - 1_500_000_000_000) < 1000, 'confidential file leaked into signature');

  // A symlink to a newer file must not be followed.
  const target = path.join(mk('chronicle-fresh-link-'), 't.md');
  fs.writeFileSync(target, 'z'); touch(target, 4_000_000_000_000);
  fs.symlinkSync(target, path.join(dir, 'records', 'link.md'));
  const max2 = treeMaxMtimeMs(dir, (n) => n.endsWith('.md'), prune);
  assert.ok(Math.abs(max2 - 1_500_000_000_000) < 1000, 'symlink target leaked into signature');
});

test('freshSlice recomputes only when the signature changes', () => {
  let sig = 'v1', computes = 0;
  const run = () => freshSlice('t.a', () => sig, () => { computes++; return sig; });
  assert.equal(run(), 'v1'); assert.equal(computes, 1);
  assert.equal(run(), 'v1'); assert.equal(computes, 1); // unchanged sig -> memoized
  sig = 'v2';
  assert.equal(run(), 'v2'); assert.equal(computes, 2); // changed -> recompute
});

test('freshSlice TTL gate skips the signature check inside the window', () => {
  let sigCalls = 0;
  const sigFn = () => { sigCalls++; return 'stable'; };
  const run = () => freshSlice('t.ttl', sigFn, () => 'val', { ttlMs: 60_000 });
  assert.equal(run(), 'val'); assert.equal(sigCalls, 1); // first: sig computed
  assert.equal(run(), 'val'); assert.equal(sigCalls, 1); // within TTL: sig NOT recomputed
});

test('invalidateSlice forces the next read to recompute', () => {
  let computes = 0;
  const run = () => freshSlice('t.inv', () => 'same', () => { computes++; return 'v'; });
  run(); run(); assert.equal(computes, 1);
  invalidateSlice('t.inv');
  run(); assert.equal(computes, 2);
});

test('writeHubCache/readHubCache roundtrip under CHRONICLE_DATA_DIR', () => {
  writeHubCache('memory', 'sig-1', { nodes: [1, 2, 3] });
  const got = readHubCache('memory');
  assert.deepEqual(got, { sig: 'sig-1', value: { nodes: [1, 2, 3] } });
  assert.ok(hubCacheDir().startsWith(data), 'hub-cache must live under the data dir');
  assert.equal(readHubCache('never-written'), null);
  // No stray temp files left behind by the atomic write.
  assert.ok(!fs.readdirSync(hubCacheDir()).some((f) => f.includes('.tmp')));
});
