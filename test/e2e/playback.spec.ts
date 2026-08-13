// Playback P0s (Task 7, spec §2.3): (1) timeline click/scrub is dead past
// the first segment, (2) selecting a message doesn't drive the middle file
// tree + right code panel.
//
// Root-cause note (full evidence in the task report): symptom (1) does NOT
// reproduce with uniformly-dense message timestamps — Task 1's original
// fixture generator spaced every line 2-40s apart, so nearest-message
// selection always lands within a fraction of a percent of the clicked
// point. It reproduces reliably once a session has a REAL gap in activity
// (confirmed on Chronicle's own repo session 2391e843-af58-46cf-8260-…: a
// genuine 5h48m pause between message seq 472 and 473 collapsed ~49
// percentage-points of the timeline track onto exactly 2 selectable
// positions). Task 7 adds one deliberate multi-hour gap to the shared big
// fixture (test/fixtures/gen-big-session.mjs's GAP_AFTER_TURN/GAP_MS) so
// this is reproducible deterministically in CI without depending on real
// user data.
//
// Symptom (2) — the code-snapshot panel not reacting to selection — needs a
// real git repo to observe at all (the fixture's own cwd, /tmp/fixture-
// project, deliberately has none — see the E2E harness comment in
// helpers.ts). This spec creates a small, deterministic, idempotent git
// repo at that exact path during setup (server/git.ts resolves snapshot
// commands against the project's stored `path`, which is the fixture
// session's `cwd`) purely to give the commit/file-tree assertions something
// to react to. Investigating this symptom found the panel DOES update
// correctly in every case — the actual defect was latency-shaped: gitAt/
// gitTree/gitFile each shell out to `git` synchronously (server/git.ts,
// execFileSync — blocks the whole Node event loop for the subprocess's
// duration), so a snapshot change can take a perceptible moment with no
// visual acknowledgement in between, which is indistinguishable from "the
// panel doesn't react" during that window. Waits below poll for the actual
// DOM change (Playwright's auto-retrying `expect`) rather than a fixed
// sleep, and the fix adds a loading indicator (CodePanel.tsx) — see the
// task report.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

// Must match FIXTURE_CWD in test/fixtures/gen-big-session.mjs — the fixture
// JSONL's `cwd` field, which becomes the imported project's `path`. The
// JSONL files themselves live under a throwaway mkdtemp dir (see
// helpers.ts); this repo is a separate, minimal side-channel that exists
// purely so server/git.ts's isGitRepo(project.path) finds real history.
const FIXTURE_REPO_DIR = '/tmp/fixture-project';

interface FixtureMessage {
  seq: number;
  ts?: string | null;
  is_sidechain?: 0 | 1;
}
interface SessionMessagesResponse {
  messages: FixtureMessage[];
}

async function fetchPlaybackMessages(): Promise<FixtureMessage[]> {
  const res = await fetch(`${state.baseURL}/api/sessions/${encodeURIComponent(state.sessionId)}/messages`);
  const data = (await res.json()) as SessionMessagesResponse;
  return data.messages
    .filter((m) => !m.is_sidechain && m.ts)
    .sort((a, b) => a.seq - b.seq);
}

function git(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync('git', ['-C', FIXTURE_REPO_DIR, ...args], { encoding: 'utf8', env });
}

// Idempotent (wipe + recreate) so repeated local `npm run test:e2e` runs
// don't accumulate history. Not safe under concurrent local runs — same
// accepted caveat as helpers.ts's STATE_FILE; not a CI risk (CI is single-run).
function makeFixtureRepo(commit1Iso: string, commit2Iso: string): void {
  fs.rmSync(FIXTURE_REPO_DIR, { recursive: true, force: true });
  fs.mkdirSync(FIXTURE_REPO_DIR, { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'fixture@chronicle.test']);
  git(['config', 'user.name', 'Chronicle Fixture']);

  const authoredAt = (iso: string): NodeJS.ProcessEnv => ({
    ...process.env,
    GIT_AUTHOR_NAME: 'Chronicle Fixture', GIT_AUTHOR_EMAIL: 'fixture@chronicle.test',
    GIT_COMMITTER_NAME: 'Chronicle Fixture', GIT_COMMITTER_EMAIL: 'fixture@chronicle.test',
    GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso,
  });

  fs.writeFileSync(path.join(FIXTURE_REPO_DIR, 'a.txt'), 'v1\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture commit 1 - add a.txt'], authoredAt(commit1Iso));

  fs.writeFileSync(path.join(FIXTURE_REPO_DIR, 'a.txt'), 'v2\n');
  fs.writeFileSync(path.join(FIXTURE_REPO_DIR, 'b.txt'), 'new file\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture commit 2 - update a.txt, add b.txt'], authoredAt(commit2Iso));
}

test.beforeAll(async () => {
  const messages = await fetchPlaybackMessages();
  // commit 1: safely before every message (so ANY selection at/after the
  // fixture's very first message resolves to it as the nearest-preceding
  // commit). commit 2: dated at message index 300 — still well inside the
  // initial ~400-message playback window (selection starts at the first
  // user message), so both a "before" and "after" message card are
  // clickable without first scrolling/seeking anywhere.
  const commit1Iso = new Date(new Date(messages[0].ts!).getTime() - 3_600_000).toISOString();
  const commit2Iso = messages[300].ts!;
  makeFixtureRepo(commit1Iso, commit2Iso);
});

async function gotoFixturePlayback(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/session/${encodeURIComponent(state.sessionId)}`);
  await page.locator('button[title^="Playback"]').click();
  await expect(page.locator('.timeline')).toBeVisible();
}

interface TrackRect { left: number; top: number; width: number; height: number; }

async function timelineRect(page: Page): Promise<TrackRect> {
  return page.evaluate(() => {
    const el = document.querySelector('.timeline') as HTMLElement;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });
}

async function clickTrackAt(page: Page, rect: TrackRect, frac: number): Promise<void> {
  await page.mouse.click(rect.left + rect.width * frac, rect.top + rect.height / 2);
}

async function cursorLeftPct(page: Page): Promise<number> {
  const left = await page.locator('.tl-cursor').evaluate((el) => (el as HTMLElement).style.left);
  return parseFloat(left);
}

// Empirically finds the fixture's deliberate multi-hour gap rather than
// hardcoding its location — robust to any future change in where/how big
// it is (see GAP_AFTER_TURN/GAP_MS in test/fixtures/gen-big-session.mjs).
function findLargestGap(messages: FixtureMessage[]): { startFrac: number; endFrac: number; sizeMs: number } {
  const minTs = new Date(messages[0].ts!).getTime();
  const maxTs = new Date(messages[messages.length - 1].ts!).getTime();
  const span = maxTs - minTs;
  let gapStart = 0, gapEnd = 0, gapSize = -1;
  for (let i = 1; i < messages.length; i++) {
    const d = new Date(messages[i].ts!).getTime() - new Date(messages[i - 1].ts!).getTime();
    if (d > gapSize) { gapSize = d; gapStart = new Date(messages[i - 1].ts!).getTime(); gapEnd = new Date(messages[i].ts!).getTime(); }
  }
  return { startFrac: (gapStart - minTs) / span, endFrac: (gapEnd - minTs) / span, sizeMs: gapSize };
}

// ── Symptom 1: timeline click/scrub dead past the first segment ───────────

test('timeline click moves the playhead proportionally across the whole track, including through a real multi-hour gap', async ({ page }) => {
  const messages = await fetchPlaybackMessages();
  const gap = findLargestGap(messages);
  expect(gap.sizeMs, 'fixture must contain a deliberate multi-hour gap').toBeGreaterThan(60 * 60 * 1000);

  // Two distinct points strictly inside the gap span.
  const clickA = gap.startFrac + (gap.endFrac - gap.startFrac) * 0.3;
  const clickB = gap.startFrac + (gap.endFrac - gap.startFrac) * 0.7;

  await gotoFixturePlayback(page);
  const rect = await timelineRect(page);

  await clickTrackAt(page, rect, clickA);
  const leftA = await cursorLeftPct(page);
  await clickTrackAt(page, rect, clickB);
  const leftB = await cursorLeftPct(page);

  // Pre-fix, both clicks land inside the same dead zone and resolve to
  // whichever boundary message is nearest in time — i.e. leftA and leftB
  // collapse to (at most) two fixed values regardless of exactly where in
  // the gap you click. Post-fix, the playhead tracks the raw click
  // position, so each lands close to its own requested fraction.
  expect(Math.abs(leftA - clickA * 100), `clicked ${(clickA * 100).toFixed(2)}% but playhead is at ${leftA}%`).toBeLessThan(2);
  expect(Math.abs(leftB - clickB * 100), `clicked ${(clickB * 100).toFixed(2)}% but playhead is at ${leftB}%`).toBeLessThan(2);
  expect(leftB - leftA, 'two distinct clicks inside the gap must not collapse onto the same playhead position').toBeGreaterThan(2);
});

test('dragging the timeline through the gap tracks the pointer the whole way (no frozen segment)', async ({ page }) => {
  const messages = await fetchPlaybackMessages();
  const gap = findLargestGap(messages);

  // Sweep from well before the gap to well after it, including several
  // points strictly inside it.
  const fracs = [
    Math.max(0, gap.startFrac - 0.1),
    gap.startFrac + (gap.endFrac - gap.startFrac) * 0.15,
    gap.startFrac + (gap.endFrac - gap.startFrac) * 0.4,
    gap.startFrac + (gap.endFrac - gap.startFrac) * 0.6,
    gap.startFrac + (gap.endFrac - gap.startFrac) * 0.85,
    Math.min(1, gap.endFrac + 0.1),
  ];

  await gotoFixturePlayback(page);
  const rect = await timelineRect(page);
  const y = rect.top + rect.height / 2;

  await page.mouse.move(rect.left + rect.width * fracs[0], y);
  await page.mouse.down();
  const seen: number[] = [];
  for (const frac of fracs) {
    await page.mouse.move(rect.left + rect.width * frac, y, { steps: 3 });
    seen.push(await cursorLeftPct(page));
  }
  await page.mouse.up();

  // Every drag step must land close to its own target fraction — a frozen
  // "dead" run would show two or more of these clustered at the same value
  // regardless of how far apart their fracs are.
  for (let i = 0; i < fracs.length; i++) {
    expect(Math.abs(seen[i] - fracs[i] * 100), `drag step ${i} (frac ${fracs[i].toFixed(3)}) landed at ${seen[i]}%`).toBeLessThan(2);
  }
});

// ── Symptom 2: selection doesn't drive the file tree / code panel ─────────

test('selecting a message card updates the code-snapshot panel across a commit boundary', async ({ page }) => {
  await gotoFixturePlayback(page);

  const seqs = await page.evaluate(() => [...document.querySelectorAll('.msg')].map((e) => Number(e.getAttribute('data-seq'))).sort((a, b) => a - b));
  const early = seqs[5];
  const late = seqs[Math.min(350, seqs.length - 1)];

  await page.locator(`[data-seq="${early}"]`).click();
  const commitPill = page.locator('.commit-info .git-pill');
  await expect(commitPill).toBeVisible();
  const commitBefore = await commitPill.textContent();
  const treeBefore = await page.evaluate(() => [...document.querySelectorAll('.file-tree .tree-item')].map((e) => e.getAttribute('title')));

  await page.locator(`[data-seq="${late}"]`).click();
  // Poll rather than a fixed sleep: gitAt/gitTree block on a synchronous
  // `git` subprocess server-side (see the file header), so the update can
  // take a moment — Playwright's auto-retrying expect waits for the actual
  // DOM change instead of guessing a timeout.
  await expect(commitPill).not.toHaveText(commitBefore ?? '');
  const commitAfter = await commitPill.textContent();
  await expect.poll(
    async () => page.evaluate(() => [...document.querySelectorAll('.file-tree .tree-item')].map((e) => e.getAttribute('title'))),
  ).toContain('b.txt');
  const treeAfter = await page.evaluate(() => [...document.querySelectorAll('.file-tree .tree-item')].map((e) => e.getAttribute('title')));

  expect(commitAfter, 'commit hash pill must change once selection crosses a commit boundary').not.toEqual(commitBefore);
  expect(treeBefore).not.toContain('b.txt');
  expect(treeAfter, 'file tree must reflect the new commit (b.txt was added there)').toContain('b.txt');
});

test('selecting via the timeline also updates the code-snapshot panel', async ({ page }) => {
  await gotoFixturePlayback(page);
  const rect = await timelineRect(page);

  await clickTrackAt(page, rect, 0.02);
  const commitPill = page.locator('.commit-info .git-pill');
  await expect(commitPill).toBeVisible();
  const commitBefore = await commitPill.textContent();

  await clickTrackAt(page, rect, 0.98);
  await expect(commitPill).not.toHaveText(commitBefore ?? '');
});
