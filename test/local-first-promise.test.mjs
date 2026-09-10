// The local-first promise, stated precisely (issue #300, part of spec #294).
//
// ADR 0008 fixes the wording: session data never leaves the machine, Chronicle
// has no server of its own, and the one outbound call sends the operator's own
// token to its own issuer for the operator's own quota, on by default and off
// in Settings. Everything an operator reads has to say that same thing, so a
// surface that drops the plan-window exception trips CI instead of shipping.
//
// Reads git-tracked paths only (`git ls-files`), like test/repo-shape.test.mjs,
// so gitignored build output can never make this flaky.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
const tracked = git('ls-files').split('\n').filter(Boolean);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Exempt, on the same grounds test/repo-shape.test.mjs exempts them:
//   - CHANGELOG.md: history is allowed to say what a release said.
//   - this pin: it cannot forbid a claim without spelling the claim out.
//   - package-lock.json: generated, and no prose in it.
const EXEMPT = new Set([
  'CHANGELOG.md',
  'package-lock.json',
  'test/local-first-promise.test.mjs',
  // A dated audit records what a surface said on the day it was audited, so it
  // quotes the claim this pin retires. Same grounds as the CHANGELOG.
  'docs/agents/design-audit-2026-09-04.md',
]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|db)$/i;
const sweepable = tracked.filter((rel) => !EXEMPT.has(rel) && !BINARY.test(rel));

// Claims that deny the plan-window quota read exists. Each is false as written:
// the one outbound call is real, on by default, and named on the privacy page.
const OVERCLAIMS = [
  { claim: 'zero outbound', re: /\bzero outbound\b/i },
  { claim: 'no outbound network calls', re: /\b(?:no|zero) outbound network calls?\b/i },
  { claim: 'no cloud, no telemetry', re: /\bno cloud,? and no telemetry\b|\bno cloud, no telemetry\b/i },
  { claim: 'the outbound calls are none', re: /outbound calls? \(there are none\)/i },
];

test('the sweep reaches the README, the marketing site and the docs', () => {
  for (const rel of ['README.md', 'website/index.html', 'docs/guide/local-service.md']) {
    assert.ok(sweepable.includes(rel), `the overclaim sweep does not reach ${rel}`);
  }
});

for (const { claim, re } of OVERCLAIMS) {
  test(`no tracked file claims "${claim}"`, () => {
    // Per LINE, so the failure names the line a reader has to go fix.
    const offenders = [];
    for (const rel of sweepable) {
      let src;
      try { src = read(rel); } catch { continue; }
      src.split('\n').forEach((line, i) => {
        if (re.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepEqual(offenders, [], `"${claim}" is claimed again:\n  ${offenders.join('\n  ')}`);
  });
}

// The surfaces that state the promise for the whole product. Each has to say
// all three of ADR 0008's parts, because an operator reads one of these and
// stops. (Copy about ONE feature -- Ask's own panel, say -- is not on this list:
// it speaks for that feature, not for the product.)
const PROMISE_SURFACES = [
  'README.md',
  'website/index.html',
  'docs/index.md',
  'docs/guide/local-service.md',
  'docs/reference/privacy-and-data.md',
];

// Prose wraps, and markdown bolds half a sentence, so a claim is matched
// against the flattened line: emphasis stripped, whitespace collapsed.
const flatten = (src) => src.replace(/[*_`]/g, '').replace(/\s+/g, ' ');

// ADR 0008, part one: session data never leaves the machine.
const NEVER_LEAVES = /never leaves (?:your machine|the machine|it\b)/i;
// Part two: Chronicle has no server of its own.
const NO_SERVER = /no server (?:of its own|that holds)/i;
// Part three: the one outbound call, its purpose, and the toggle that stops it.
const QUOTA_READ = /(?:plan[- ]window|plan quota|subscription quota|quota)/i;
const DEFAULT_ON = /\bon by default\b/i;
const SETTINGS_OFF = /\bSettings\b/;

for (const rel of PROMISE_SURFACES) {
  test(`${rel} states the promise ADR 0008 states`, () => {
    const src = flatten(read(rel));
    assert.match(src, NEVER_LEAVES, `${rel} never says session data stays on the machine`);
    assert.match(src, NO_SERVER, `${rel} never says Chronicle has no server of its own`);
  });

  test(`${rel} names the plan-window exception, on by default and off in Settings`, () => {
    const src = flatten(read(rel));
    assert.match(src, QUOTA_READ, `${rel} never names the quota read`);
    assert.match(src, DEFAULT_ON, `${rel} does not say the quota read is on by default`);
    assert.match(src, SETTINGS_OFF, `${rel} does not say Settings turns the quota read off`);
  });

  test(`${rel} makes no unqualified "nothing leaves your machine" claim`, () => {
    // True of session data, false of the product: the quota read leaves.
    assert.doesNotMatch(
      flatten(read(rel)),
      /\bnothing leaves (?:your|the) machine\b/i,
      `${rel} claims nothing at all leaves the machine`,
    );
  });
}
