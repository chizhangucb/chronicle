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
import os from 'node:os';
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

// Prose wraps, and markdown bolds half a sentence, so a claim is matched
// against the flattened line: emphasis stripped, whitespace collapsed.
const flatten = (src) => src.replace(/[*_`]/g, '').replace(/\s+/g, ' ');

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
      // Prose wraps, and `outbound\n  network calls (there are none)` is the
      // same claim as the unwrapped one, so each line is read together with the
      // one after it and reported at the line the claim starts on.
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (re.test(flatten(`${line} ${lines[i + 1] ?? ''}`))) {
          offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
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

// --- The code that makes the call ------------------------------------------
//
// `readConfig().planWindows !== false` means the quota read is opt-OUT: absent
// config reads as on. Both comment sites described it as opt-in-off, so the
// module documented the opposite of what it does.

const MODULE = 'server/planWindows.ts';
const ROUTE = 'server/routes/planWindows.ts';

/** Every comment line in a source file, `//` and `/* *​/` alike, trimmed. */
const commentsOf = (rel) => {
  const lines = read(rel).split('\n');
  const out = [];
  let block = false;
  for (const [i, line] of lines.entries()) {
    const t = line.trim();
    if (block) {
      out.push({ n: i + 1, text: t });
      if (t.includes('*/')) block = false;
    } else if (t.startsWith('//')) {
      out.push({ n: i + 1, text: t });
    } else if (t.startsWith('/*')) {
      out.push({ n: i + 1, text: t });
      if (!t.includes('*/')) block = true;
    }
  }
  return out;
};

for (const rel of [MODULE, ROUTE]) {
  test(`${rel} documents the quota read as opt-out, not opt-in`, () => {
    const offenders = commentsOf(rel)
      .filter(({ text }) => /opt-?in/i.test(text))
      .map(({ n, text }) => `${rel}:${n}: ${text.slice(0, 100)}`);
    assert.deepEqual(
      offenders,
      [],
      `the quota read is opt-out in the code and opt-in in the comments:\n  ${offenders.join('\n  ')}`,
    );
  });

  test(`${rel} says the quota read defaults to on`, () => {
    const src = flatten(commentsOf(rel).map(({ text }) => text).join(' '));
    assert.match(src, /opt-?out/i, `${rel} never calls the quota read opt-out`);
    assert.match(src, /default(?:s to)? on\b/i, `${rel} never says the quota read defaults to on`);
  });
}

// --- The default the wording describes -------------------------------------
//
// The wording is only precise if it matches what ships, so the same pin covers
// both: absent config reads as ON, `planWindows: false` goes nowhere at all,
// and the Settings row that flips it is still there. #300 changed neither the
// toggle nor the default, and this is what would notice if a later change did.

// `server/autosync.ts` resolves the data folder once, at import time, so each
// case runs in its OWN node process with its own CHRONICLE_DATA_DIR. Same
// reason the child stubs fetch: no case of this may reach api.anthropic.com,
// on any machine, whether or not the person running it has a credential on
// disk. The child reports the fetch attempts it swallowed.
const CHILD = `
globalThis.fetch = (url) => {
  calls.push(String(url));
  return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
};
const { computePlanWindows } = await import(REPO + '/server/planWindows.ts');
const result = await computePlanWindows();
process.stdout.write(JSON.stringify({ result, calls }));
`;

const planWindowsUnder = (config) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-planwindows-'));
  if (config !== null) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  try {
    const env = { ...process.env, CHRONICLE_DATA_DIR: dir };
    delete env.CHRONICLE_DEMO;
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `const calls = [];\nconst REPO = ${JSON.stringify(REPO)};\n${CHILD}`],
      { encoding: 'utf8', env, cwd: REPO },
    );
    return JSON.parse(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('the quota read is ON for a config that never mentions it', () => {
  const { result } = planWindowsUnder(null);
  assert.equal(result.claudeEnabled, true, 'a fresh install has the quota read off');
});

test('the quota read stays ON for a config that sets other keys', () => {
  const { result } = planWindowsUnder({ autoSync: true, ask: true });
  assert.equal(result.claudeEnabled, true, 'an unrelated Settings write turned the quota read off');
});

test('planWindows:false turns the quota read off and goes nowhere', () => {
  const { result, calls } = planWindowsUnder({ planWindows: false });
  assert.equal(result.claudeEnabled, false);
  assert.equal(result.claudeUnauthed, false, 'a switched-off read must not report an auth problem');
  assert.deepEqual(calls, [], 'a switched-off quota read still went outbound');
});

test('Settings still renders the quota-read toggle, defaulted on', () => {
  const app = flatten(read('src/App.tsx'));
  assert.match(app, /planWindows: true/, 'the Settings fallback no longer defaults the toggle on');
  assert.match(
    app,
    /checked=\{settings\.planWindows !== false\}/,
    'the Settings toggle no longer reads absent config as on',
  );
  assert.match(app, /On by default/, 'the Settings copy no longer says the read is on by default');
});
