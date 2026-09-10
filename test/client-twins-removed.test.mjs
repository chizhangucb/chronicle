// Removal pins for the three client twins (issue #302, part of #294).
//
// The tool-result error heuristic, agent-active / engaged time and the session
// display name were each written twice: once on the server for a stored
// session, once by hand in the client for a live one, kept in step by a gotcha
// entry. Each now has one definition in `shared/` that both sides import, so
// the two paths cannot report different numbers or a different name.
//
// The pure behaviour of the three lives in test/error-head.test.mjs,
// test/durations.test.mjs and test/session-name.test.mjs. This file pins only
// that there is nowhere else for a second copy to live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const SOURCES = [...sourceFiles('server'), ...sourceFiles('src'), ...sourceFiles('shared')]
  .map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') }));

// One definition each, and it is the one in shared/. A `function` or `const`
// binding of these names anywhere else is the twin coming back.
const DEFINITIONS = [
  { name: 'isErrorHead', home: 'shared/errors.ts' },
  { name: 'agentActiveMs', home: 'shared/durations.ts' },
  { name: 'engagedMs', home: 'shared/durations.ts' },
  { name: 'sessionDisplayName', home: 'shared/sessionName.ts' },
];

test('each shared function is defined exactly once, in shared/', () => {
  for (const { name, home } of DEFINITIONS) {
    const defines = SOURCES
      .filter(({ text }) => new RegExp(`(function|const)\\s+${name}\\b`).test(text))
      .map(({ rel }) => rel);
    assert.deepEqual(defines, [home], `${name} should be defined only in ${home}`);
  }
});

test('the server-side homes of the moved functions are gone', () => {
  for (const rel of ['server/errors.ts', 'server/durations.ts']) {
    assert.equal(fs.existsSync(path.join(REPO, rel)), false, `${rel} moved to shared/`);
  }
});

test('the error regex is written once, and no gap cap is written inline anywhere', () => {
  const regexHits = SOURCES.filter(({ text }) => /tool_use_error\|exit code/.test(text)).map(({ rel }) => rel);
  assert.deepEqual(regexHits, ['shared/errors.ts'], 'the error regex should be written only in shared/errors.ts');

  // Both caps are named constants (ACTIVE_GAP_CAP_MS, ENGAGED_GAP_CAP_MS), so
  // an inline clamp like `Math.min(gap, 10 * 60 * 1000)` is a twin's literal
  // however it is spelled. Matched as a clamp rather than as a bare number,
  // since a ten-minute number is also a git timeout and a live-window bound
  // and neither of those is duration math.
  const inlineCaps = SOURCES.filter(({ text }) => /Math\.min\([^)]*60 \* 1000\)/.test(text)).map(({ rel }) => rel);
  assert.deepEqual(inlineCaps, [], 'a duration cap belongs in a named constant in shared/durations.ts');
});

test('the client twin gotcha is gone from the published docs', () => {
  for (const rel of ['docs/contributing/gotchas.md', 'docs/architecture/how-it-works.md']) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.ok(!/client twin/i.test(text), `${rel} still documents a client twin to keep in sync`);
  }
});
