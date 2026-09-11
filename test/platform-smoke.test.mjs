// CHI #200: the platform smoke's own moving parts.
//
// The smoke itself (scripts/ci/platform-smoke.mjs) runs on a CI runner against
// an INSTALLED tarball, so `npm test` cannot run it end to end — there is no
// dist-server/ in a dev checkout. What is pinned here is everything the smoke
// decides for itself, driven for real: the banner it reads the port out of,
// the data folder ADR 0008 promises, the "nothing written anywhere else"
// sweep, and the Claude Code transcript it plants — that last one against the
// REAL parser, so a fixture the source discovery could never find fails here
// rather than on Windows ten minutes later.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseLaunchUrl,
  expectedDataDir,
  strayHomeEntries,
  writeClaudeTranscript,
  DEFAULT_PORT,
} from '../scripts/ci/platform-smoke.mjs';
import { sourceById } from '../server/parsers/registry.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-smoke-'));

// The launcher's real banner, as bin/chronicle.mjs prints it.
const BANNER = [
  '',
  '  Chronicle is running at http://localhost:41731',
  '  Press Ctrl-C to stop.',
  '',
].join('\n');

test('the launcher banner yields the URL and the port it carries', () => {
  assert.deepEqual(parseLaunchUrl(BANNER), { url: 'http://localhost:41731', port: 41731 });
});

test('the demo build chatter before the banner does not hide it', () => {
  const noisy = `  Building the demo console (first run today)…\n  seeded 12 sessions\n${BANNER}`;
  assert.deepEqual(parseLaunchUrl(noisy), { url: 'http://localhost:41731', port: 41731 });
});

test('output with no banner yet reads as not-started', () => {
  assert.equal(parseLaunchUrl('  Building the demo console (first run today)…\n'), null);
  assert.equal(parseLaunchUrl(''), null);
});

test('the default port the launcher starts its scan at is 41730', () => {
  assert.equal(DEFAULT_PORT, 41730);
});

test('the data folder is <home>/.chronicle, and CHRONICLE_DATA_DIR wins (ADR 0008)', () => {
  assert.equal(expectedDataDir('/home/op', {}), path.join('/home/op', '.chronicle'));
  assert.equal(
    expectedDataDir('/home/op', { CHRONICLE_DATA_DIR: '/tmp/elsewhere' }),
    '/tmp/elsewhere',
  );
  // An empty value is not a data dir; it must not silently relocate the folder.
  assert.equal(expectedDataDir('/home/op', { CHRONICLE_DATA_DIR: '' }), path.join('/home/op', '.chronicle'));
});

test('a write outside the data folder and the source logs is reported', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.chronicle'));
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  assert.deepEqual(strayHomeEntries(home), [], 'the two expected folders are not strays');

  fs.writeFileSync(path.join(home, '.chronicle-backup'), 'x');
  fs.mkdirSync(path.join(home, '.config'));
  assert.deepEqual(strayHomeEntries(home).sort(), ['.chronicle-backup', '.config']);
});

test('the planted transcript is one the real Claude Code parser finds', async () => {
  const home = tmp();
  const planted = writeClaudeTranscript(home);

  assert.ok(fs.existsSync(planted.file), 'no transcript was written');
  assert.equal(
    path.dirname(path.dirname(planted.logDir)),
    path.join(home, '.claude'),
    'the transcript must sit under <home>/.claude/projects',
  );

  const source = sourceById('claude-code');
  const scanned = source.scan(path.join(home, '.claude', 'projects'));
  assert.equal(scanned.length, 1, 'the scan found no importable project');
  assert.equal(scanned[0].source, 'claude-code');
  assert.equal(scanned[0].sessionCount, 1);
  assert.equal(scanned[0].physicalPath, planted.cwd, 'the scan read a different project path');
  assert.deepEqual(scanned[0].sessions.map((s) => s.id), [planted.sessionId]);

  // And it parses into real messages — a transcript that scans but imports
  // nothing would pass the discovery half and fail the import half.
  const parsed = await source.parse(scanned[0]);
  assert.equal(parsed.length, 1);
  assert.ok(parsed[0].events.length >= 2, `expected messages, got ${parsed[0].events.length}`);
  assert.ok(
    parsed[0].events.some((e) => e.kind === 'assistant'),
    'the transcript has no assistant turn, so nothing would show in Playback',
  );
});

test('the transcript is deterministic: two plants are byte-identical', () => {
  const a = writeClaudeTranscript(tmp());
  const b = writeClaudeTranscript(tmp());
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(fs.readFileSync(a.file, 'utf8'), fs.readFileSync(b.file, 'utf8'));
});
