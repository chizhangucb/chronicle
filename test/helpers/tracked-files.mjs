// The ONE reader of the repo's tracked file list, shared by the pins that sweep
// it: test/repo-shape.test.mjs (retired vocabulary, retired routes, retired
// modules) and test/local-first-promise.test.mjs (the promise wording).
//
// Same reason test/helpers/retired-vocabulary.mjs exists: two copies of a sweep
// drifted apart once already and a live offender sat in a contract file while
// its guard test passed (issue #186). One definition, two callers.
//
// Tracked paths only (`git ls-files`), so gitignored artifacts (dist/,
// node_modules/, .DS_Store) can never make a sweep flaky.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const git = (...args) =>
  execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });

export const tracked = git('ls-files').split('\n').filter(Boolean);

/**
 * Prose flattened for matching: emphasis and backticks stripped, whitespace
 * collapsed. Prose wraps and markdown bolds half a sentence, so a claim only
 * matches reliably against this form. Shared for the same reason `tracked` is:
 * two copies of a sweep drifted apart once already (issue #186).
 */
export const flatten = (src) => src.replace(/[*_`]/g, '').replace(/\s+/g, ' ');

export const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/** Binary files: read as utf8 they are noise, and none of them carries prose. */
export const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|db)$/i;
