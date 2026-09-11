#!/usr/bin/env node
//
// Platform screenshots (issue #200): what does the published app LOOK like on
// this OS?
//
// The launch half of the smoke (scripts/ci/platform-smoke.mjs) proves the
// server answers. This half proves the UI renders, and it exists mainly for
// the glyphs: the `--mono` stack is `ui-monospace, "SF Mono", Menlo,
// monospace`, and neither named face ships on Windows or Linux, so every
// glyph in the app leans on whatever per-glyph fallback the OS picks. Tofu is
// something a human recognises in a second and no DOM probe can see, so this
// takes the pictures and the workflow uploads them as an artifact.
//
// Three shots per OS: the sidebar, one Playback session (the busiest in the
// demo data, so the kind markers on the rows are all present), and a glyph
// sheet rendered in the shipped font stack with each code point labelled, so
// a tofu box can be named in an issue without guesswork.
//
// Usage:
//   node scripts/ci/platform-screenshots.mjs --package-dir <pkg> --out <dir>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, waitFor, freePort, tempHome, homeEnv } from './platform-smoke.mjs';

/**
 * The value of the `--mono` design token in a stylesheet.
 *
 * Read out of the SHIPPED bundle rather than retyped, so the sheet is rendered
 * in the same stack the app uses.
 *
 * @param {string} css - stylesheet text, minified or not.
 * @returns {string | null} the font stack, or null when the token is gone.
 */
export function monoStack(css) {
  const m = /--mono:\s*([^;}]+)/.exec(css);
  return m ? m[1].trim() : null;
}

/**
 * The canonical mono glyph vocabulary, read from spec/design-qa-rubric.md.
 *
 * Reading the contract keeps the sheet in step with the app: a glyph added to
 * the vocabulary shows up on the next run's sheet with no edit here. Every
 * non-ASCII code point inside backticks in that one bullet is a glyph; the
 * file paths and test names sharing those backticks are ASCII and drop out.
 *
 * @param {string} rubric - the text of spec/design-qa-rubric.md.
 * @returns {string[]} one glyph per entry, in the order the rubric names them.
 */
export function canonicalGlyphs(rubric) {
  const start = rubric.indexOf('- **Mono glyph vocabulary');
  if (start === -1) throw new Error('spec/design-qa-rubric.md no longer holds a mono glyph vocabulary bullet');
  const rest = rubric.slice(start + 1);
  const end = rest.search(/\n- \*\*/);
  const bullet = end === -1 ? rest : rest.slice(0, end);

  const glyphs = [];
  for (const span of bullet.matchAll(/`([^`\n]+)`/g)) {
    for (const ch of span[1]) {
      if (ch.codePointAt(0) > 0x7f && !glyphs.includes(ch)) glyphs.push(ch);
    }
  }
  return glyphs;
}

/**
 * The session worth a Playback screenshot: the one with the most messages.
 *
 * @param {{ id: string, message_count: number | null }[]} sessions
 * @returns {{ id: string } | null} null when the scope has no sessions at all.
 */
export function pickPlaybackSession(sessions) {
  let best = null;
  for (const s of sessions) {
    if (!best || (s.message_count ?? 0) > (best.message_count ?? 0)) best = s;
  }
  return best;
}

/**
 * The artifact file name for one shot on one OS.
 *
 * The two runners upload one artifact EACH (upload-artifact@v4 seals an
 * artifact on close, so a shared name would 409). The platform is in the file
 * name as well, so the two artifacts can be downloaded into one folder and
 * compared side by side without colliding.
 *
 * @param {string} kind - `sidebar`, `playback` or `glyphs`.
 * @param {string} platform - a `process.platform` value.
 */
export function screenshotName(kind, platform) {
  return `${kind}-${platform}.png`;
}

/** The shipped client CSS bundle inside an installed package. */
function shippedCss(packageDir) {
  const assets = path.join(packageDir, 'dist', 'assets');
  const file = fs.readdirSync(assets).find((f) => f.endsWith('.css'));
  if (!file) throw new Error(`no stylesheet in ${assets}: is dist/ built?`);
  return fs.readFileSync(path.join(assets, file), 'utf8');
}

/** The glyph sheet as a standalone page, in the app's own font stack. */
function glyphSheetHtml(glyphs, stack, platform) {
  const cells = glyphs.map((g) => `
    <figure>
      <span class="g">${g}</span>
      <figcaption>U+${g.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}</figcaption>
    </figure>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>glyphs</title>
<style>
  body { background: #14110e; color: #e8e2d9; margin: 0; padding: 28px;
         font-family: ${stack}; }
  h1 { font-size: 15px; letter-spacing: .06em; text-transform: uppercase; margin: 0 0 4px; }
  p  { font-size: 12px; color: #a39a8c; margin: 0 0 22px; }
  .sheet { display: grid; grid-template-columns: repeat(7, 1fr); gap: 18px; }
  figure { margin: 0; text-align: center; border: 1px solid #3a332b; padding: 12px 0 8px; }
  .g { font-family: ${stack}; font-size: 42px; line-height: 1.1; display: block; }
  figcaption { font-size: 10px; color: #a39a8c; margin-top: 8px; }
</style>
<h1>Chronicle mono glyphs, ${platform}</h1>
<p>font-family: ${stack}. A box or a question mark here is tofu on this OS.</p>
<div class="sheet">${cells}</div>`;
}

async function main(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
  const packageDir = arg('--package-dir');
  const outDir = arg('--out');
  if (!packageDir || !outDir) {
    console.error('Usage: node scripts/ci/platform-screenshots.mjs --package-dir <pkg> --out <dir>');
    process.exit(2);
  }
  const pkg = path.resolve(packageDir);
  const out = path.resolve(outDir);
  fs.mkdirSync(out, { recursive: true });

  const stack = monoStack(shippedCss(pkg));
  if (!stack) throw new Error('the shipped CSS carries no --mono token');
  const rubricPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../spec/design-qa-rubric.md');
  const glyphs = canonicalGlyphs(fs.readFileSync(rubricPath, 'utf8'));
  console.log(`${process.platform}: ${glyphs.length} glyphs, mono stack ${stack}`);

  // Chromium comes from the repo checkout's dev dependency; imported lazily so
  // the pure exports above stay importable without Playwright installed.
  const { chromium } = await import('@playwright/test');

  // --demo: synthetic sessions, so the UI has something to render on a runner
  // with no transcripts of its own.
  const home = tempHome('screens');
  const port = await freePort();
  const app = await launch(pkg, ['--no-open', '--demo', '--port', String(port)], homeEnv(home));
  // Inside the try: a Chromium that fails to launch must still stop the app,
  // or a failed run leaves a Chronicle server holding the port on the runner.
  let browser;
  try {
    browser = await chromium.launch();
    await waitFor(`${app.url}/api/projects`);
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

    // ---- The sidebar, on the Insights home.
    await page.goto(app.url, { waitUntil: 'networkidle' });
    const sidebar = page.locator('aside.sidebar');
    await sidebar.waitFor({ state: 'visible', timeout: 30_000 });
    await sidebar.screenshot({ path: path.join(out, screenshotName('sidebar', process.platform)) });
    console.log(`  wrote ${screenshotName('sidebar', process.platform)}`);

    // ---- One Playback session: the busiest one in the demo data.
    const projects = await (await waitFor(`${app.url}/api/projects`)).json();
    if (!projects.length) throw new Error('demo mode served no projects');
    const detail = await (await waitFor(`${app.url}/api/projects/${projects[0].id}`)).json();
    const session = pickPlaybackSession(detail.sessions ?? []);
    if (!session) throw new Error(`demo project ${projects[0].id} served no sessions`);
    await page.goto(`${app.url}/session/${encodeURIComponent(session.id)}`, { waitUntil: 'networkidle' });
    await page.locator('button[title^="Playback"]').click();
    await page.locator('.timeline').waitFor({ state: 'visible', timeout: 30_000 });
    await page.screenshot({ path: path.join(out, screenshotName('playback', process.platform)), fullPage: false });
    console.log(`  wrote ${screenshotName('playback', process.platform)} (session ${session.id})`);

    // ---- The glyph sheet, in the shipped font stack.
    await page.setContent(glyphSheetHtml(glyphs, stack, process.platform), { waitUntil: 'load' });
    await page.screenshot({ path: path.join(out, screenshotName('glyphs', process.platform)), fullPage: true });
    console.log(`  wrote ${screenshotName('glyphs', process.platform)}`);
  } finally {
    await browser?.close().catch(() => {});
    await app.stop();
  }
  console.log(`Screenshots for ${process.platform} are in ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
