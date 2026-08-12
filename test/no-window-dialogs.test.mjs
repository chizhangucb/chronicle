import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// PROJ-01 regression guard: window.prompt/confirm/alert silently no-op in
// embedded/preview browser contexts (see CLAUDE.md), so the project rename /
// unlink / error flows must use inline affordances instead. This asserts the
// touched views never reintroduce a native dialog call.
const FILES = ['../src/ProjectDetail.tsx', '../src/HomePage.tsx'];
const BANNED = /\b(?:window\.)?(?:prompt|confirm|alert)\s*\(/;

for (const rel of FILES) {
  test(`${rel} has no window.prompt/confirm/alert dialog`, () => {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    for (const line of src.split('\n')) {
      // Ignore the word inside identifiers/comments — only flag call sites.
      const m = line.match(BANNED);
      assert.equal(m, null, `banned dialog call in ${rel}: ${line.trim()}`);
    }
  });
}
