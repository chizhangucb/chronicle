// CHI #200: the default-browser open is the one launch step the platform
// smoke cannot observe — a headless runner has no default browser and no
// window to watch. So the command the launcher BUILDS is pinned here instead,
// for all three platforms, including the two nobody develops on.
//
// The launcher itself starts a server on import, so the command builder lives
// in bin/open-command.mjs as a pure function and is imported directly. What is
// pinned is the exact argv each platform gets, because that is what a user on
// that platform executes: `open <url>`, `cmd /c start "" <url>` (the empty
// string is start's title argument — without it a quoted URL becomes the
// window title and nothing opens), `xdg-open <url>`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserOpenCommand } from '../bin/open-command.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = 'http://localhost:41730';

test('macOS opens the URL with `open`', () => {
  assert.deepEqual(browserOpenCommand('darwin', URL_), { command: 'open', args: [URL_] });
});

test('Windows opens the URL with `cmd /c start "" <url>`', () => {
  assert.deepEqual(browserOpenCommand('win32', URL_), {
    command: 'cmd',
    args: ['/c', 'start', '', URL_],
  });
});

test('Linux opens the URL with `xdg-open`', () => {
  assert.deepEqual(browserOpenCommand('linux', URL_), { command: 'xdg-open', args: [URL_] });
});

test('an unknown platform falls back to the freedesktop opener', () => {
  // freebsd, openbsd and friends all ship xdg-open; guessing `open` there
  // would run BSD's unrelated `open`.
  assert.deepEqual(browserOpenCommand('freebsd', URL_), { command: 'xdg-open', args: [URL_] });
});

test('the URL is passed as its own argv entry, never interpolated into a string', () => {
  // A URL carries `&` and `?`; anything that builds a shell string out of it
  // is one quoting bug away from running the tail as a command.
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { command, args } = browserOpenCommand(platform, 'http://localhost:41731/?a=1&b=2');
    assert.ok(!command.includes('http'), `${platform} put the URL in the command`);
    assert.ok(
      args.includes('http://localhost:41731/?a=1&b=2'),
      `${platform} did not pass the URL as one argv entry: ${JSON.stringify(args)}`,
    );
  }
});

test('the launcher builds its open command from this one function', () => {
  // The pin is worth nothing if bin/chronicle.mjs keeps its own copy of the
  // platform switch.
  const src = fs.readFileSync(path.join(REPO, 'bin', 'chronicle.mjs'), 'utf8');
  assert.match(src, /from '\.\/open-command\.mjs'/, 'the launcher does not import the shared builder');
  assert.doesNotMatch(src, /process\.platform === 'darwin'/, 'the launcher still switches on platform itself');
});
