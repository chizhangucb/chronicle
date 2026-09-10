// Unit test for shared/errors.ts — the ONE tool_result error heuristic, read
// by the server (session error_count at import, Explore's per-tool
// attribution) and by the client (the Overview Errors card and its Playback
// drill-in). One function, so a live session and a stored session cannot
// disagree about what counts as an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isErrorHead, ERROR_HEAD_CHARS } from '../shared/errors.ts';

test('isErrorHead: true for each shape of failure the heuristic recognizes', () => {
  const errors = [
    'Error: ENOENT: no such file or directory',
    '  fatal: not a git repository',
    'Traceback (most recent call last):',
    '<tool_use_error>File has not been read yet.</tool_use_error>',
    'npm test exited with exit code 1',
    'command failed: tsc -b',
    'bash: ./deploy.sh: permission denied',
  ];
  for (const text of errors) assert.equal(isErrorHead(text), true, `expected an error head: ${text}`);
});

test('isErrorHead: false for a successful tool result, including one that merely mentions errors', () => {
  assert.equal(isErrorHead('ok, wrote 3 files'), false);
  assert.equal(isErrorHead('0 errors, 0 warnings'), false);
  assert.equal(isErrorHead('exit code 0'), false);
  assert.equal(isErrorHead(''), false);
});

test('isErrorHead: only the head is tested, so a failure past the head does not count', () => {
  // The SQL side tests substr(text, 1, 200); the JS side must cut at the same
  // place or a long successful result would be counted as an error server-side
  // and not client-side (or the other way round).
  assert.equal(ERROR_HEAD_CHARS, 200);
  const padded = `${'ok '.repeat(80)}command failed`;
  assert.ok(padded.indexOf('command failed') > ERROR_HEAD_CHARS);
  assert.equal(isErrorHead(padded), false);
  assert.equal(isErrorHead(padded.slice(padded.indexOf('command failed'))), true);
});
