// Removal pin for the shrink (#224): the `chronicle hub set|status|clear`
// subcommand, its entrypoint validation, the hub env vars and the config key
// are gone. The launcher takes flags only.
//
// The launcher is exercised as a real child process rather than imported: it
// starts a server on import, and the exit code + stderr are what a user
// actually sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(repo, 'bin', 'chronicle.mjs');

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('--help lists the live flags and no hub anything', () => {
  const { code, stdout } = run(['--help']);
  assert.equal(code, 0);
  for (const flag of ['--port', '--no-open', '--demo', '--app', '--help']) {
    assert.match(stdout, new RegExp(flag.replace(/-/g, '\\-')));
  }
  assert.doesNotMatch(stdout, /hub/i);
});

test('a hub subcommand is rejected as an unknown command', () => {
  for (const args of [['hub'], ['hub', 'status'], ['hub', 'set', '/tmp/x'], ['hub', 'clear']]) {
    const { code, stderr } = run(args);
    assert.equal(code, 1, `expected rejection for: ${args.join(' ')}`);
    assert.match(stderr, /Unknown command "hub"/);
  }
});

test('--port keeps taking its value; a stray word still fails', () => {
  // The port value is a bare word too, so the unknown-command scan must skip it.
  assert.equal(run(['--port', 'nope']).code, 1); // invalid port, not "unknown command"
  assert.match(run(['--port', 'nope']).stderr, /Invalid --port/);
  assert.match(run(['sync']).stderr, /Unknown command "sync"/);
});

test('no entrypoint or server file reads a hub env var', () => {
  // server/gate/core.ts still carries an injected `hubRoot` option for the
  // hub-writing gate surfaces; nothing feeds it, and those rows are retired by
  // their own ticket. What must never come back here is a hub knob READ from
  // the environment.
  const files = [
    'bin/chronicle.mjs',
    ...fs.readdirSync(path.join(repo, 'server'), { recursive: true })
      .filter((f) => typeof f === 'string' && f.endsWith('.ts'))
      .map((f) => path.join('server', f)),
  ];
  const offenders = files.filter((rel) => {
    const src = fs.readFileSync(path.join(repo, rel), 'utf8');
    return /CHRONICLE_HUB|process\.env\.AIOS_HUB/.test(src);
  });
  assert.deepEqual([...new Set(offenders)], [], `hub env knobs are back in: ${offenders}`);
});

test('ChronicleConfig no longer declares the hub config key', () => {
  const src = fs.readFileSync(path.join(repo, 'server', 'autosync.ts'), 'utf8');
  assert.doesNotMatch(src, /hubRoot/);
});

test('a config file that still holds the legacy hubRoot key loads and round-trips', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-hubcfg-'));
  process.env.CHRONICLE_DATA_DIR = dir;
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ hubRoot: '/some/old/hub', autoSync: false }, null, 2),
  );
  const { readConfig, writeConfig } = await import('../server/autosync.ts');
  assert.equal(readConfig().autoSync, false);
  writeConfig({ autoSync: true });
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(after.autoSync, true);
  assert.equal(after.hubRoot, '/some/old/hub', 'legacy key must survive a write');
});
