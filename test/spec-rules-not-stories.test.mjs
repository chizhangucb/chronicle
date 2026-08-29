// Re-bloat guard for the spec/ contracts (CHI-388).
//
// surface-contract.md, design-qa-rubric.md and product-contract.md are normative
// contracts a reviewer judges against, so they read as rules, not stories. They
// had drifted into narrative: 112 CHI-nnn refs, dated sign-off paragraphs, spec-§
// pointers, incident history. Chronicle is PUBLIC and its decision log lives
// OFF-repo in the hub, so a ticket/decision ref in a spec is a dead pointer to an
// external reader and an off-repo one to a fresh clone; the trace lives in git
// blame + the hub log by surface name. This pin keeps the prose ref-free so it
// cannot silently drift back.
//
// It scans PROSE only: fenced code blocks and inline `code spans` are stripped
// first, so a css token, a file path, or a test name that happens to contain a
// digit is never flagged. Story lives in prose, not in code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'spec');
const FILES = fs.readdirSync(SPEC).filter((f) => f.endsWith('.md'));

/** Drop fenced blocks and inline code spans so only prose is scanned. */
function prose(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')   // fenced code blocks
    .replace(/`[^`]*`/g, ' ');          // inline code spans
}

// Each marker is a story/ref pattern that does not belong in a rule. `allow` is a
// narrow carve-out for a literal that is product copy, not a pointer.
const MARKERS = [
  { name: 'ticket ref', re: /\bCHI-\d+/g, allow: /CHI-NNN/ },
  { name: 'decision ref (D<n>)', re: /\bD\d{1,2}\b/g },
  { name: 'date', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { name: 'spec-section ref', re: /§\s*\d/g },
  { name: 'task ref', re: /\bTask \d+/g },
  { name: 'narrative marker', re: /\bfeedback-round\b/g },
];

for (const file of FILES) {
  test(`spec/${file} reads as rules, not stories (no ticket/decision/date refs in prose)`, () => {
    const text = prose(fs.readFileSync(path.join(SPEC, file), 'utf8'));
    const hits = [];
    for (const { name, re, allow } of MARKERS) {
      for (const m of text.matchAll(re)) {
        if (allow && allow.test(m[0])) continue;
        hits.push(`${name}: "${m[0]}"`);
      }
    }
    assert.deepEqual(
      hits, [],
      `spec/${file} carries story/refs that belong in the hub decision log, not the contract:\n  ${hits.join('\n  ')}`,
    );
  });
}
