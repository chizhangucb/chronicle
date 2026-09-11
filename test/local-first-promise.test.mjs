// The local-first promise, stated precisely (issue #300, part of spec #294).
//
// ADR 0008 fixes the wording: session data never leaves the machine, Chronicle
// has no server of its own, and the one outbound call sends the operator's own
// token to its own issuer for the operator's own plan windows, on by default
// and off in Settings. Everything an operator reads has to say that same
// thing, so a surface that drops the plan-window exception trips CI instead
// of shipping.
//
// Reads the tracked corpus through test/helpers/tracked-files.mjs, the same
// reader test/repo-shape.test.mjs sweeps, so gitignored build output can never
// make this flaky and the two sweeps cannot disagree about what is in scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, tracked, read, flatten, BINARY } from './helpers/tracked-files.mjs';

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
const sweepable = tracked.filter((rel) => !EXEMPT.has(rel) && !BINARY.test(rel));

// Claims that deny the plan-window read exists. Each is false as written:
// the one outbound call is real, on by default, and named on the privacy page.
const OVERCLAIMS = [
  { claim: 'zero outbound', re: /\bzero outbound\b/i },
  { claim: 'no outbound network calls', re: /\b(?:no|zero) outbound network calls?\b/i },
  { claim: 'zero network calls', re: /\b(?:zero|no) network calls\b/i },
  { claim: 'no cloud, no telemetry', re: /\bno cloud,? and no telemetry\b|\bno cloud, no telemetry\b/i },
  { claim: 'no cloud, no LLM calls', re: /\bno cloud, no LLM calls\b/i },
  { claim: 'the outbound calls are none', re: /outbound calls? \(there are none\)/i },
  // `readConfig().planWindows !== false` is opt-OUT: absent config reads as on.
  // Every place that called the plan-window read opt-in-off documented the opposite
  // of what ships -- the module, the route, the client and the contract.
  { claim: 'the plan-window read is opt-in-off', re: /opt-?in-off/i },
];

test('the sweep reaches the README, the marketing site and the docs', () => {
  for (const rel of ['README.md', 'website/index.html', 'docs/guide/local-service.md']) {
    assert.ok(sweepable.includes(rel), `the overclaim sweep does not reach ${rel}`);
  }
});

// The corpus is flattened ONCE, not once per claim: every claim sweeps every
// tracked file, so re-reading and re-flattening the repo per claim is the same
// work N times over. `self` is the line alone; `pair` is the line joined to the
// one after it, because prose wraps and `outbound\n  network calls (there are
// none)` is the same claim as the unwrapped one.
const CORPUS = sweepable.flatMap((rel) => {
  let src;
  try { src = read(rel); } catch { return []; }
  const lines = src.split('\n');
  const self = lines.map(flatten);
  return [{
    rel,
    self,
    pair: lines.map((line, i) => flatten(`${line} ${lines[i + 1] ?? ''}`)),
    text: lines.map((line) => line.trim().slice(0, 100)),
  }];
});

for (const { claim, re } of OVERCLAIMS) {
  test(`no tracked file claims "${claim}"`, () => {
    // Per LINE, so the failure names the line a reader has to go fix. A claim
    // that sits wholly on the NEXT line is left to that line's own turn,
    // otherwise every such offender is reported twice.
    const offenders = [];
    for (const { rel, self, pair, text } of CORPUS) {
      for (let i = 0; i < self.length; i++) {
        const startsHere = re.test(self[i]) || (re.test(pair[i]) && !re.test(self[i + 1] ?? ''));
        if (startsHere) offenders.push(`${rel}:${i + 1}: ${text[i]}`);
      }
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
const PLAN_WINDOW_READ = /plan[- ]windows?/i;
const DEFAULT_ON = /\bon by default\b/i;
const SETTINGS_OFF = /\bSettings\b/;

/** Every stretch of prose surrounding a mention of `re`, one per mention. */
const passagesAround = (text, re, before = 200, after = 400) => {
  const out = [];
  const all = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
  for (const m of text.matchAll(all)) {
    out.push(text.slice(Math.max(0, m.index - before), m.index + after));
  }
  return out;
};

for (const rel of PROMISE_SURFACES) {
  test(`${rel} states the promise ADR 0008 states`, () => {
    const src = flatten(read(rel));
    assert.match(src, NEVER_LEAVES, `${rel} never says session data stays on the machine`);
    assert.match(src, NO_SERVER, `${rel} never says Chronicle has no server of its own`);
  });

  test(`${rel} names the plan-window exception, on by default and off in Settings`, () => {
    const src = flatten(read(rel));
    assert.match(src, PLAN_WINDOW_READ, `${rel} never names the plan-window read`);
    // Around the mention, not merely somewhere in the file: a page that names
    // the read in one section and says "on by default" about something else in
    // another has not stated the exception.
    const near = passagesAround(src, PLAN_WINDOW_READ);
    assert.ok(
      near.some((p) => DEFAULT_ON.test(p) && SETTINGS_OFF.test(p)),
      `${rel} names the plan-window read without saying, beside it, that it is on by default and off in Settings`,
    );
  });

  test(`${rel} makes no unqualified "nothing leaves your machine" claim`, () => {
    // True of session data, false of the product: the plan-window read leaves.
    assert.doesNotMatch(
      flatten(read(rel)),
      /\bnothing leaves (?:your|the) machine\b/i,
      `${rel} claims nothing at all leaves the machine`,
    );
  });
}

// --- The code that makes the call ------------------------------------------
//
// `readConfig().planWindows !== false` means the plan-window read is opt-OUT: absent
// config reads as on. Every comment site described it the other way round, so
// the code documented the opposite of what it does.

const MODULE = 'server/planWindows.ts';
const ROUTE = 'server/routes/planWindows.ts';

// A comment that TRAILS code (`const on = cfg.x !== false; // opt-in`) is the
// easiest kind to leave stale, so it is swept too. The `[^:]` guard is what
// keeps `'https://api.anthropic.com/...'` from reading as one.
const TRAILING = /(?:^|[^:])(\/\/.*)$/;

/** Every comment in a source file, `//`, trailing `//` and `/* *​/` alike, trimmed. */
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
    } else {
      const trailing = TRAILING.exec(t);
      if (trailing) out.push({ n: i + 1, text: trailing[1] });
    }
  }
  return out;
};

/** The leading comment block of a file: everything above its first code line. */
const headerOf = (rel) => {
  const out = [];
  for (const line of read(rel).split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    if (!t.startsWith('//')) break;
    out.push(t);
  }
  return out.join(' ');
};

for (const rel of [MODULE, ROUTE]) {
  test(`${rel} documents the plan-window read as opt-out, not opt-in`, () => {
    const offenders = commentsOf(rel)
      .filter(({ text }) => /opt-?in/i.test(text))
      .map(({ n, text }) => `${rel}:${n}: ${text.slice(0, 100)}`);
    assert.deepEqual(
      offenders,
      [],
      `the plan-window read is opt-out in the code and opt-in in the comments:\n  ${offenders.join('\n  ')}`,
    );
  });
}

// Whole-comment sweeps catch a stray line anywhere in the file; these two pin
// the exact places the ticket names, so a correct sentence further down the
// file cannot stand in for a wrong module header.
const saysOptOutDefaultOn = (where, text) => {
  const src = flatten(text);
  assert.match(src, /opt-?out/i, `${where} never calls the plan-window read opt-out`);
  assert.match(src, /default(?:s to)? on\b/i, `${where} never says the plan-window read defaults to on`);
};

test(`${MODULE}'s module header says opt-out, default on`, () => {
  saysOptOutDefaultOn(`${MODULE}'s header`, headerOf(MODULE));
});

test(`${ROUTE}'s route comment says opt-out, default on`, () => {
  // The route's own comment sits inside mountPlanWindows, under the header.
  const routeComment = commentsOf(ROUTE)
    .map(({ text }) => text)
    .join(' ');
  saysOptOutDefaultOn(`${ROUTE}'s route comment`, routeComment);
});

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
const childSource = () => `
const calls = [];
globalThis.fetch = (url) => {
  calls.push(String(url));
  return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
};
const { computePlanWindows } = await import(${JSON.stringify(`${REPO}/server/planWindows.ts`)});
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
      ['--input-type=module', '-e', childSource()],
      { encoding: 'utf8', env, cwd: REPO },
    );
    return JSON.parse(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('the plan-window read is ON for a config that never mentions it', () => {
  const { result } = planWindowsUnder(null);
  assert.equal(result.claudeEnabled, true, 'a fresh install has the plan-window read off');
});

test('the plan-window read stays ON for a config that sets other keys', () => {
  const { result } = planWindowsUnder({ autoSync: true, ask: true });
  assert.equal(result.claudeEnabled, true, 'an unrelated Settings write turned the read off');
});

test('planWindows:false turns the plan-window read off and goes nowhere', () => {
  const { result, calls } = planWindowsUnder({ planWindows: false });
  assert.equal(result.claudeEnabled, false);
  assert.equal(result.claudeUnauthed, false, 'a switched-off read must not report an auth problem');
  assert.deepEqual(calls, [], 'a switched-off plan-window read still went outbound');
});

test('Settings still renders the plan-windows row, defaulted on', () => {
  const app = flatten(read('src/App.tsx'));
  assert.match(app, /planWindows: true/, 'the Settings fallback no longer defaults the toggle on');
  assert.match(
    app,
    /checked=\{settings\.planWindows !== false\}/,
    'the Settings toggle no longer reads absent config as on',
  );
  assert.match(app, /On by default/, 'the Settings copy no longer says the read is on by default');
});
