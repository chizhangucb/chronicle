// Copies the canonical Markdown from the repo's ../docs into ./docs so VitePress
// can serve it at /docs/*. The repo's docs/ stays the single source of truth;
// this generated copy (gitignored) keeps the site in sync on every build.
//
// - Excludes internal-only content (superpowers/ specs, the PRD).
// - Rewrites the handful of links that point OUTSIDE docs/ (repo-root files and
//   the excluded PRD) to absolute GitHub URLs so nothing 404s on the site.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', '..', 'docs'); // repo docs/ (canonical)
const DEST = path.resolve(__dirname, '..', 'docs'); // website/docs/ (generated, VitePress srcDir)
const GH = 'https://github.com/chizhangucb/chronicle';

// Top-level entries under docs/ that must NOT ship on the public site.
const EXCLUDE = new Set(['superpowers', 'AI-session-manager-PRD.md']);

// Link targets outside docs/ → absolute GitHub URLs. (Prefix match; the PRD rule
// preserves any trailing #anchor before the closing paren.)
const REWRITES = [
  ['](../README.md)', `](${GH}/blob/main/README.md)`],
  ['](../CHANGELOG.md)', `](${GH}/blob/main/CHANGELOG.md)`],
  ['](../LICENSE)', `](${GH}/blob/main/LICENSE)`],
  ['](AI-session-manager-PRD.md', `](${GH}/blob/main/docs/AI-session-manager-PRD.md`],
];

function rewrite(md) {
  let out = md;
  for (const [from, to] of REWRITES) out = out.split(from).join(to);
  return out;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (src === SRC && EXCLUDE.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      files += copyDir(s, d);
    } else if (entry.name.endsWith('.md')) {
      fs.writeFileSync(d, rewrite(fs.readFileSync(s, 'utf8')));
      files += 1;
    } else {
      fs.copyFileSync(s, d); // images, etc.
    }
  }
  return files;
}

if (!fs.existsSync(SRC)) {
  console.error(`[content] repo docs/ not found at ${SRC}`);
  process.exit(1);
}
fs.rmSync(DEST, { recursive: true, force: true });
const n = copyDir(SRC, DEST);
console.log(`[content] copied ${n} markdown files → website/docs/ (excluded: ${[...EXCLUDE].join(', ')})`);

// Generate the English changelog page from the repo's CHANGELOG.md (single source of
// truth). Localized changelogs live as committed files under docs/zh, docs/ja.
const CHANGELOG = path.resolve(SRC, '..', 'CHANGELOG.md');
if (fs.existsSync(CHANGELOG)) {
  fs.writeFileSync(path.join(DEST, 'changelog.md'), rewrite(fs.readFileSync(CHANGELOG, 'utf8')));
  console.log('[content] generated changelog.md from CHANGELOG.md');
}
