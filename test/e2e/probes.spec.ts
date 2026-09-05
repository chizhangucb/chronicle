// Task 7 (feedback-round plan): DOM-assertion probes walked across every
// route/mode at ONE reference width (1366 — the 3-width overflow sweep
// already lives in layout.spec.ts/smoke.spec.ts/projects.spec.ts; this file
// does not repeat it). Each route is visited ONCE and all applicable probe
// categories run against that single page state, per the brief's "walk
// routes once per width, not once per assertion" note.
//
// Probe (d) TIME-AXIS is D12 (user decision, added to this task after the
// brief was written): for every rendered time-series chart, the x-axis
// category values must be exactly one bucket unit apart, consecutively — the
// regression shape D12/Task 18 fixed (server/explore.ts's rollup buckets and
// src/charts/timeBuckets.ts's `densifyBuckets` used to collapse an idle gap
// into equal spacing between distant buckets, misrepresenting time).
//
// Recharts tick-decimation gotcha (verified empirically against this exact
// fixture before writing this probe): a wide bucket range (e.g. Hourly+All
// on the big fixture, ~35 bars) only renders ~15 of its x-axis tick LABELS —
// Recharts hides overlapping ticks for legibility, it does not render one
// per bucket. Reading `.recharts-xAxis-tick-labels text` under a wide range
// would see labels 4-5 buckets apart and wrongly flag every gap as a
// densify regression. So this probe deliberately drives each chart into a
// SMALL, bounded bucket count (a 7-day window, daily granularity) where
// Recharts renders every tick — see `forceHomeExploreDaily7d` etc. below —
// rather than reading ticks off whatever range a plain route visit happens
// to land on.
import { type Page } from '@playwright/test';
import { test, expect, readSeedState } from './helpers.ts';

const state = readSeedState();
const WIDTH = 1366;

// ── (a) SPACE probe: known label/value row classes must keep >=4px of ──────
// horizontal gap to their paired sibling, and never overflow their own box.
// The last rule is the brief's generic scan (not one of the 3 known
// classes above): any APP-AUTHORED element whose class contains "label"
// (`.sb-label`, `.wiz-step-label`, `.wiz-sess-label`, `.bytype-label`,
// `.ctx-label`, …), checked against whatever immediately follows it in the
// DOM — the exact `[class*=label] + *` shape from the brief. Reuses the same
// selector+sibling mechanism as the 3 known-class rules (not a separate
// implementation), so a single shared skip/gap/overflow logic covers both.
//
// `:not([class*="recharts"])` excludes Recharts' OWN internal SVG classes —
// verified live: Recharts 3.x renders each x/y-axis tick as its own
// `<g class="recharts-xAxis-tick-labels">…<text>12:40 PM</text></g>` (one
// such element PER TICK, sharing that class name across ticks), which
// contains "label" as a substring and matched this rule before the
// exclusion. That's a library-internal axis-tick wrapper with its own
// Recharts-computed spacing algorithm, not an app-authored label/value UI
// pair (the SPACE category this probe targets — see the design rubric's
// "no run-together label+value" — and TIME-AXIS above already separately
// audits chart-tick correctness, just for bucketing, not pixel gaps). Without
// the exclusion this rule flagged real charts (e.g. the session Overview
// "Cost over session" chart) for Recharts' own occasionally-tight adjacent
// tick spacing, which the app has no direct authorship over.
interface SpaceRule { selector: string; sibling: 'next' | 'prev'; }
const SPACE_RULES: SpaceRule[] = [
  { selector: '.trow .k', sibling: 'next' }, // label -> .t (value)
  { selector: '.sel-check', sibling: 'next' }, // checkbox -> row title
  { selector: '.day-head .sum', sibling: 'prev' }, // .d (day label) -> .sum (value)
  { selector: '[class*="label"]:not([class*="recharts"])', sibling: 'next' }, // generic label-class scan (brief's [class*=label] + *)
];

async function probeSpace(page: Page): Promise<string[]> {
  return page.evaluate((rules) => {
    const problems: string[] = [];
    for (const { selector, sibling } of rules) {
      for (const el of Array.from(document.querySelectorAll(selector)) as HTMLElement[]) {
        const other = (sibling === 'next' ? el.nextElementSibling : el.previousElementSibling) as HTMLElement | null;
        // Skip pairs with no adjacent sibling, or where the sibling carries
        // no text (e.g. a bare icon/dot next to a label) — there's no
        // label/value gap to police when the "value" side is empty.
        if (other && (other.textContent || '').trim()) {
          const a = el.getBoundingClientRect();
          const b = other.getBoundingClientRect();
          const gap = sibling === 'next' ? b.left - a.right : a.left - b.right;
          // Only meaningful for elements laid out on the same row — a label
          // stacked ABOVE/BELOW its sibling (block layout, e.g. a label on
          // its own line above a wrapped value) has a legitimate vertical
          // gap, not a horizontal one; skip those rather than flag a bogus
          // negative/huge "gap".
          const sameRow = Math.abs(a.top - b.top) < Math.max(a.height, b.height, 1);
          if (sameRow && gap < 4) {
            problems.push(`SPACE ${selector}: gap=${gap.toFixed(1)}px to ${sibling} sibling (< 4px) — "${(el.textContent || '').trim().slice(0, 30)}"`);
          }
        }
        if (el.scrollWidth > el.clientWidth + 1) {
          problems.push(`SPACE ${selector}: text overflows its box (scrollWidth=${el.scrollWidth} clientWidth=${el.clientWidth}) — "${(el.textContent || '').trim().slice(0, 30)}"`);
        }
      }
    }
    return problems;
  }, SPACE_RULES);
}

// ── (b) TRUNCATION probe: every clamped + actually-overflowing element ─────
// must carry a non-empty `title` (the hover-shows-full-name contract).
async function probeTruncation(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      const cs = getComputedStyle(el);
      const lineClamp = cs.getPropertyValue('-webkit-line-clamp');
      const clamps = cs.textOverflow === 'ellipsis' || (lineClamp !== '' && lineClamp !== 'none');
      if (!clamps) continue;
      const overflowingX = el.scrollWidth > el.clientWidth + 1;
      const overflowingY = el.scrollHeight > el.clientHeight + 1;
      if (!overflowingX && !overflowingY) continue;
      const title = el.getAttribute('title');
      if (!title || !title.trim()) {
        const cls = Array.from(el.classList).join('.');
        const tag = el.tagName.toLowerCase();
        problems.push(`TRUNCATION ${tag}${cls ? '.' + cls : ''}: clamped + overflowing with no title — "${(el.textContent || '').trim().slice(0, 40)}"`);
      }
    }
    return problems;
  });
}

// ── (c) LEGEND probe: no `.legend` entry renders as a bare integer ─────────
async function probeLegend(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    for (const entry of Array.from(document.querySelectorAll('.legend > *'))) {
      const text = (entry.textContent || '').trim();
      if (/^\d+$/.test(text)) problems.push(`LEGEND entry is a bare integer: "${text}"`);
    }
    return problems;
  });
}

// ── (d) TIME-AXIS probe: consecutive x-axis buckets are exactly ──────
// one unit apart. Two label shapes appear in this codebase for a "daily"
// series (see shared/bucketLabel.ts / src/charts/timeBuckets.ts):
//   named-month "Aug 9"      — Home's spend-over-time chart, Explore's daily rollup
//   numeric "MM-DD"          — ProjectDetail's trend-card (its own tickFormatter)
// Both omit the year, so a label sequence is reconstructed into timestamps
// with a MONOTONIC year correction (bump a placeholder year forward whenever
// the next label would otherwise land on or before the previous one) —
// handles a genuine Dec31->Jan1 rollover in the underlying data without ever
// needing to know the real year, since consecutive dense buckets are always
// less than a year apart.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseNamedDayLabel(label: string): { mo: number; d: number } | null {
  const m = /^([A-Za-z]{3}) (\d{1,2})$/.exec(label.trim());
  if (!m) return null;
  const mo = MONTHS.indexOf(m[1]);
  if (mo < 0) return null;
  return { mo, d: Number(m[2]) };
}
function parseNumericDayLabel(label: string): { mo: number; d: number } | null {
  const m = /^(\d{2})-(\d{2})$/.exec(label.trim());
  if (!m) return null;
  return { mo: Number(m[1]) - 1, d: Number(m[2]) };
}

function assertConsecutiveDaily(
  labels: string[],
  parse: (l: string) => { mo: number; d: number } | null,
  context: string,
): void {
  expect(labels.length, `${context}: expected at least 2 dense day buckets, got ${labels.length} (${JSON.stringify(labels)})`).toBeGreaterThanOrEqual(2);
  const problems: string[] = [];
  let year = 2000;
  let prevTs: number | null = null;
  let prevLabel = '';
  for (const label of labels) {
    const parts = parse(label);
    if (!parts) { problems.push(`TIME-AXIS ${context}: unparseable label "${label}"`); continue; }
    let dt = new Date(year, parts.mo, parts.d).getTime();
    while (prevTs !== null && dt <= prevTs) { year += 1; dt = new Date(year, parts.mo, parts.d).getTime(); }
    if (prevTs !== null) {
      const diffDays = Math.round((dt - prevTs) / 86400000);
      if (diffDays !== 1) {
        problems.push(`TIME-AXIS ${context}: "${prevLabel}" -> "${label}" is ${diffDays} day(s) apart, expected exactly 1 (dense-fill regression)`);
      }
    }
    prevTs = dt;
    prevLabel = label;
  }
  expect(problems, problems.join('; ')).toEqual([]);
}

// Read a chart's x-axis tick labels and assert a dense consecutive-daily series,
// RETRYING until the axis settles on the freshly-clicked window. A range-bar
// click re-renders recharts in place — the prior window's bars and ticks linger
// for a frame or two while the new data animates in — so a one-shot read can
// catch the OLD window's decimated, every-other-day ticks. That is exactly how
// the /project/:id Overview probe flaked: its default window is
// wide (Aug 1 -> Aug 27, ticks decimated to every 2nd day), and the goto helper
// waits only for a `.recharts-bar-rectangle` to be visible — which the lingering
// wide-window bars satisfy immediately — so the label read fired before the 7d
// re-render replaced the axis. toPass reruns the read+assert until it settles;
// a GENUINE dense-fill regression never becomes consecutive, so it still fails
// (just after the retry budget) — the regression guard is preserved.
async function expectDenseDailyAxis(
  page: Page,
  selector: string,
  parse: (l: string) => { mo: number; d: number } | null,
  context: string,
): Promise<void> {
  await expect(async () => {
    const labels = await page.locator(selector).allTextContents();
    assertConsecutiveDaily(labels, parse, context);
  }).toPass({ timeout: 8000, intervals: [100, 200, 400, 800] });
}

async function fixtureProjectId(): Promise<number> {
  const res = await fetch(`${state.baseURL}/api/sessions/${encodeURIComponent(state.sessionId)}/resolve`);
  const body = (await res.json()) as { project_id: number };
  return body.project_id;
}

// Drives Home's Overview "Spend over time · stacked by project" chart into a
// bounded 7d window (daily granularity — hourlySpend only populates for
// days<=2, see server/insights.ts) so every bucket gets its own tick.
async function gotoHomeOverview7d(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/`);
  await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
  await page.locator('.home-dashboard .rangebar button', { hasText: /^7d$/ }).click();
  // Spend-over-time is FULL-WIDTH now (`.sot-card`), no longer in a `.grid2` row
  //.
  await expect(page.locator('.sot-card .recharts-bar-rectangle').first()).toBeVisible();
}

// Drives Home's Explore tab into Rollup=Daily + 7d — bounded bucket count
// (at most ~8 days), always renders every tick (no decimation).
async function gotoHomeExploreDaily7d(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/`);
  await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
  await page.locator('.home-dashboard .tabs .tab', { hasText: /^Explore$/ }).click();
  await page.locator('.home-dashboard .rangebar button', { hasText: /^7d$/ }).click();
  await page.locator('.pivot button.pv:has-text("Rollup")').click();
  await page.locator('.menu-pop .menu-item:has-text("Daily")').click();
  await expect(page.locator('.recharts-bar-rectangle').first()).toBeVisible();
}

async function gotoProjectOverview7d(page: Page, projectId: number): Promise<void> {
  await page.goto(`${state.baseURL}/project/${projectId}`);
  await expect(page.locator('.project-detail .kpis').first()).toBeVisible();
  await page.locator('.project-detail .rangebar button', { hasText: /^7d$/ }).click();
  await expect(page.locator('.trend-card .recharts-bar-rectangle').first()).toBeVisible();
}

async function gotoProjectExploreDaily7d(page: Page, projectId: number): Promise<void> {
  await page.goto(`${state.baseURL}/project/${projectId}/explore`);
  // NOT `.kpis` — that only renders on the Overview subview (ProjectDetail.tsx
  // `{tab === 'overview' && <><div className="kpis">…`), so navigating
  // straight to /explore never renders it and this wait would time out.
  // `.rangebar` is rendered above the sub-tabs, before the tab-specific
  // branch, so it's present on every project subview.
  await expect(page.locator('.project-detail .rangebar').first()).toBeVisible();
  await page.locator('.project-detail .rangebar button', { hasText: /^7d$/ }).click();
  await page.locator('.pivot button.pv:has-text("Rollup")').click();
  await page.locator('.menu-pop .menu-item:has-text("Daily")').click();
  await expect(page.locator('.recharts-bar-rectangle').first()).toBeVisible();
}

// Runs the three generic DOM probes and reports everything in ONE assertion
// (per-route, not per-probe) so a single failing test lists every finding on
// that route together.
async function runGenericProbes(page: Page, routeLabel: string): Promise<void> {
  const [space, truncation, legend] = await Promise.all([probeSpace(page), probeTruncation(page), probeLegend(page)]);
  const problems = [...space, ...truncation, ...legend];
  expect(problems, `${routeLabel}:\n${problems.join('\n')}`).toEqual([]);
}

test.describe('probes @ 1366px', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: WIDTH, height: 900 });
  });

  test('/ (Home Overview, 7d)', async ({ page }) => {
    await gotoHomeOverview7d(page);
    await runGenericProbes(page, '/ Overview');
    await expectDenseDailyAxis(page, '.sot-card .recharts-xAxis-tick-labels text', parseNamedDayLabel, '/ Overview spend-over-time chart');
  });

  test('/ (Home Explore, Daily rollup, 7d)', async ({ page }) => {
    await gotoHomeExploreDaily7d(page);
    await runGenericProbes(page, '/ Explore');
    await expectDenseDailyAxis(page, '.recharts-xAxis-tick-labels text', parseNamedDayLabel, '/ Explore daily rollup chart');
  });

  test('/ (Home Content)', async ({ page }) => {
    await page.goto(`${state.baseURL}/?tab=content`);
    await expect(page.locator('.tabs .tab.on')).toHaveText('Content');
    await runGenericProbes(page, '/ Content');
  });

  test('/projects', async ({ page }) => {
    await page.goto(`${state.baseURL}/projects`);
    await expect(page.locator('.projects-page .rail-proj').first()).toBeVisible();
    await runGenericProbes(page, '/projects');
  });

  test('/project/:id Overview', async ({ page }) => {
    const projectId = await fixtureProjectId();
    await gotoProjectOverview7d(page, projectId);
    await runGenericProbes(page, '/project/:id Overview');
    await expectDenseDailyAxis(page, '.trend-card .recharts-xAxis-tick-labels text', parseNumericDayLabel, '/project/:id Overview trend chart');
  });

  test('/project/:id Explore (Daily rollup, 7d)', async ({ page }) => {
    const projectId = await fixtureProjectId();
    await gotoProjectExploreDaily7d(page, projectId);
    await runGenericProbes(page, '/project/:id Explore');
    await expectDenseDailyAxis(page, '.recharts-xAxis-tick-labels text', parseNamedDayLabel, '/project/:id Explore daily rollup chart');
  });

  test('/project/:id Content', async ({ page }) => {
    const projectId = await fixtureProjectId();
    await page.goto(`${state.baseURL}/project/${projectId}/content`);
    // Same `.kpis`-is-Overview-only gotcha as gotoProjectExploreDaily7d above.
    await expect(page.locator('.project-detail .rangebar').first()).toBeVisible();
    await runGenericProbes(page, '/project/:id Content');
  });

  test('/project/:id Sessions (select mode, to exercise .sel-check)', async ({ page }) => {
    const projectId = await fixtureProjectId();
    await page.goto(`${state.baseURL}/project/${projectId}`);
    await expect(page.locator('.project-detail .kpis').first()).toBeVisible();
    await page.locator('.project-detail .tabs .tab', { hasText: /^Sessions$/ }).click();
    await expect(page.locator('.session-list')).toBeVisible();
    // `.sel-check` (the SPACE probe's 3rd rule) only renders in select mode
    // (ProjectDetail.tsx's `sessionSelect.selectMode`) — enter it so this
    // walk actually exercises that rule instead of vacuously finding zero
    // elements.
    await page.locator('.filter-chips button', { hasText: /Select/ }).click();
    await expect(page.locator('.sel-check').first()).toBeVisible();
    await runGenericProbes(page, '/project/:id Sessions');
  });

  test('/session/:id Overview', async ({ page }) => {
    await page.goto(`${state.baseURL}/session/${encodeURIComponent(state.sessionId)}`);
    await expect(page.getByRole('heading', { name: /Files touched/ })).toBeVisible();
    await runGenericProbes(page, '/session/:id Overview');
  });

  test('/session/:id Playback', async ({ page }) => {
    await page.goto(`${state.baseURL}/session/${encodeURIComponent(state.sessionId)}`);
    await expect(page.getByRole('heading', { name: /Files touched/ })).toBeVisible();
    await page.locator('button[title^="Playback"]').click();
    await expect(page.locator('.timeline')).toBeVisible();
    await runGenericProbes(page, '/session/:id Playback');
  });

  test('/session/:id Refine', async ({ page }) => {
    await page.goto(`${state.baseURL}/session/${encodeURIComponent(state.sessionId)}`);
    await expect(page.getByRole('heading', { name: /Files touched/ })).toBeVisible();
    await page.locator('button[title^="Refine"]').click();
    await expect(page.locator('.refine')).toBeVisible();
    await runGenericProbes(page, '/session/:id Refine');
  });

  test('/session/:id Security Check', async ({ page }) => {
    await page.goto(`${state.baseURL}/session/${encodeURIComponent(state.sessionId)}`);
    await expect(page.getByRole('heading', { name: /Files touched/ })).toBeVisible();
    await page.locator('button[title="Security Check"]').click();
    await expect(page.locator('.modal .sec-summary, .modal .error-banner')).toBeVisible();
    await runGenericProbes(page, '/session/:id Security Check');
  });
});
