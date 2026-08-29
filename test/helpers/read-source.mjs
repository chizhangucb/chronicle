// Read a source file for an off-disk assertion, tolerant of a mid-write read.
//
// Two pins read src/ off disk on PURPOSE (page-width.test.mjs, the css; and
// reference-registry.test.mjs, every .tsx): a module import would not see a raw
// pixel width or an inline InfoTip string, so the read has to hit the real file.
// The cost is a race (CHI-382): a read that lands inside a truncate+write window
// returns an empty or partial file and fails an assertion non-deterministically,
// which is why the flake only ever bit while an agent or human was editing as the
// suite ran, never on CI's clean checkout.
//
// The fix keeps the off-disk read and just refuses to trust a suspiciously short
// one: `fs.writeFileSync` opens with O_TRUNC, so the window shows a 0-byte (or,
// for a large file, a fractional) read, which no real source file here can be.
// One re-read after a beat lands after the write completes. We do NOT switch to
// importing the modules: that would defeat the exact property these pins guard.
import fs from 'node:fs';

/** Synchronous sleep (test helper): block the thread `ms` without a busy spin. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read `file` as utf8, re-reading a short result up to a few times.
 *
 * @param {string} file
 * @param {{minBytes?: number}} [opts] minBytes is the floor below which a read is
 *   treated as truncated and retried. Default 1 (retry only a 0-byte read, which
 *   is false-positive-free for any non-empty source file). Callers that know the
 *   file is large (the 140KB styles.css) pass a higher floor to also catch a
 *   partial read, still safely below the real size.
 */
export function readSource(file, { minBytes = 1 } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const text = fs.readFileSync(file, 'utf8');
    if (text.length >= minBytes) return text;
    sleepSync(15); // caught a truncate+write window; give the writer time to land
  }
  return fs.readFileSync(file, 'utf8'); // exhausted retries: return whatever it is
}
