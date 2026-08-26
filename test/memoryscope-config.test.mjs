// Pins loadMemoryConfig (CHI-339): the read side of the memory-scope gate
// surface. Deliberately no adapter/route integration test here — the loader's
// default path resolves through the REAL os.homedir() (the gate surface's
// ${HOME} template is never CHRONICLE_DATA_DIR-overridable), so every case
// below passes an explicit tmp path instead of touching a real ~/.chronicle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadMemoryConfig, DEFAULT_MEMORY_CONFIG, DEFAULT_MEMORY_SCOPE } = await import('../server/hub/slices/memoryscope.ts');

function tmpConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-memscope-'));
  return path.join(dir, 'memory-scope.json');
}

test('absent file: defaults, source "defaults"', () => {
  const p = tmpConfigPath(); // never written
  const { config, source } = loadMemoryConfig(p);
  assert.deepEqual(config, DEFAULT_MEMORY_CONFIG);
  assert.equal(source, 'defaults');
});

test('malformed JSON: falls back to defaults, never throws', () => {
  const p = tmpConfigPath();
  fs.writeFileSync(p, '{ not json');
  const { config, source } = loadMemoryConfig(p);
  assert.deepEqual(config, DEFAULT_MEMORY_CONFIG);
  assert.equal(source, 'defaults');
});

test('no "memory" key: defaults', () => {
  const p = tmpConfigPath();
  fs.writeFileSync(p, JSON.stringify({ other: 1 }));
  const { config, source } = loadMemoryConfig(p);
  assert.deepEqual(config, DEFAULT_MEMORY_CONFIG);
  assert.equal(source, 'defaults');
});

test('partial scope: only the given tiers override, others keep their defaults', () => {
  const p = tmpConfigPath();
  fs.writeFileSync(p, JSON.stringify({ memory: { scope: { living: ['notes'] } } }));
  const { config, source } = loadMemoryConfig(p);
  assert.equal(source, 'config');
  assert.deepEqual(config.scope.living, ['notes']);
  assert.deepEqual(config.scope.historical, DEFAULT_MEMORY_SCOPE.historical);
  assert.deepEqual(config.scope.excluded, DEFAULT_MEMORY_SCOPE.excluded);
  assert.equal(config.rotDays, DEFAULT_MEMORY_CONFIG.rotDays);
});

test('full config: scope + rotDays + rotDaysByKind all applied', () => {
  const p = tmpConfigPath();
  fs.writeFileSync(p, JSON.stringify({
    memory: {
      scope: { living: ['docs'], historical: ['logs'], excluded: ['build'] },
      rotDays: 45,
      rotDaysByKind: { governance: 365 },
    },
  }));
  const { config, source } = loadMemoryConfig(p);
  assert.equal(source, 'config');
  assert.deepEqual(config.scope, { living: ['docs'], historical: ['logs'], excluded: ['build'] });
  assert.equal(config.rotDays, 45);
  assert.deepEqual(config.rotDaysByKind, { governance: 365 });
});

test('malformed tier (not a string array): that tier falls back to its default', () => {
  const p = tmpConfigPath();
  fs.writeFileSync(p, JSON.stringify({ memory: { scope: { living: 'not-an-array' } } }));
  const { config } = loadMemoryConfig(p);
  assert.deepEqual(config.scope.living, DEFAULT_MEMORY_SCOPE.living);
});

test('invalid rotDays (negative/zero/non-number): falls back to default', () => {
  const p = tmpConfigPath();
  fs.writeFileSync(p, JSON.stringify({ memory: { rotDays: -5 } }));
  const { config } = loadMemoryConfig(p);
  assert.equal(config.rotDays, DEFAULT_MEMORY_CONFIG.rotDays);
});
