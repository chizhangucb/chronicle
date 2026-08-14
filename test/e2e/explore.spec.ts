// Explore hourly rollup + brush, and the "Other" fold-in segment (Task 10,
// spec §2.4). Two things are under test:
//
// 1. Hourly must always render at hourly granularity — server/explore.ts no
//    longer silently coarsens a dense hourly request down to daily; the
//    client windows the (possibly large) bucket series with a Recharts
//    <Brush> instead of relying on the server to thin it out.
// 2. The stacked-by-group time-series chart's "Other" fold-in (non-topN
//    group values) renders as an actual, distinctly-colored, legend-labeled
//    bar segment, not just table/legend text elsewhere on the page.
//
// Date-window gotcha (documented per the brief): the shared BIG fixture
// (test/fixtures/gen-big-session.mjs) pins its messages to a FIXED date
// (2026-08-01..03, deterministic — no Date.now()), while the explore engine's
// `days=` cutoff is computed against the REAL clock at request time. A 7d/30d
// cutoff can silently exclude every fixture row depending on when this suite
// happens to run (a real failure mode hit while writing this spec: 7d/30d
// windows returned zero rows against this same fixture). "All" (days=null,
// no cutoff) is the only range guaranteed to include the fixture regardless
// of today's date, so every test here selects it explicitly rather than
// relying on the default 30d range.
//
// Task 7 update: test/e2e/helpers.ts's `launchSeeded` now ALSO seeds two mini
// sessions timestamped relative to Date.now() AT SEED TIME (`spanningSessionId`/
// `todayOnlySessionId`), so Today/7d/30d windows ARE genuinely testable now —
// see window-matrix.spec.ts, which exercises exactly that. This file's own
// tests still pin to "All" deliberately, though: they need the BIG fixture's
// ~2450-turn density (many distinct hourly buckets, a real brush-drag target,
// a non-trivial "Other" fold), which the two small relative-time sessions
// don't provide and which is still pinned to the fixed 2026-08 date above.
//
// Metric gotcha: group=model's default Spend/Tokens path buckets by SESSION
// `started_at` (server/explore.ts's EXACT_USAGE_GROUPS) — the fixture is one
// session, so that path always collapses to exactly ONE bucket regardless of
// rollup, which would make "hourly renders many buckets" untestable.
// Metric=Requests buckets by per-MESSAGE `ts` instead (any group), which is
// what actually exercises many distinct hourly buckets against this fixture.
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

async function gotoExploreHourly(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/`);
  await page.locator('.tabs button:has-text("Explore")').click();
  await page.locator('.rangebar button:has-text("All")').click();
  await page.locator('.pivot button.pv:has-text("Metric")').click();
  await page.locator('.menu-pop .menu-item:has-text("Requests")').click();
  await page.locator('.pivot button.pv:has-text("Rollup")').click();
  await page.locator('.menu-pop .menu-item:has-text("Hourly")').click();
  // Bars only ever come from the bucketed Recharts <BarChart> (the
  // rollup!=='total' view) — the ranked/Total view is hand-rolled divs with
  // no `.recharts-bar-rectangle` at all — so waiting for one is a real
  // "the hourly chart has rendered" signal, not a timing guess.
  await expect(page.locator('.recharts-bar-rectangle').first()).toBeVisible();
}

test.describe('Explore hourly rollup + brush (Task 10)', () => {
  test('Hourly + All renders many bars and a brush, never falls back to daily', async ({ page }) => {
    await gotoExploreHourly(page);

    const heading = page.locator('.card h3').first();
    await expect(heading).toContainText('Hourly');
    // The "too dense — showing <coarser>" note only appears when
    // result.rollup !== result.requestedRollup — hourly no longer coarsens,
    // so this must never show for an explicit Hourly selection.
    await expect(heading).not.toContainText('too dense');

    const barCount = await page.locator('.recharts-bar-rectangle').count();
    expect(barCount, 'expected multiple hourly bars, not a single coarsened bucket').toBeGreaterThan(1);

    await expect(page.locator('.recharts-brush')).toBeVisible();
    await expect(page.locator('.recharts-brush-traveller')).toHaveCount(2);
  });

  test('dragging the brush changes both the visible bar count and the x-axis labels', async ({ page }) => {
    await gotoExploreHourly(page);
    await expect(page.locator('.recharts-brush-traveller')).toHaveCount(2);

    const barCountBefore = await page.locator('.recharts-bar-rectangle').count();
    // Recharts v3 renders tick label <text> under a SEPARATE
    // `.recharts-xAxis-tick-labels` zIndex layer, not nested inside
    // `.recharts-xAxis` itself (confirmed against the actual DOM — a
    // `.recharts-xAxis text` selector finds nothing even when labels are
    // visibly on screen).
    const ticksBefore = await page.locator('.recharts-xAxis-tick-labels text').allTextContents();
    expect(ticksBefore.length, 'expected at least one x-axis tick before dragging').toBeGreaterThan(0);

    // Drag the END (right) traveller — `.recharts-brush-traveller` renders
    // startX's handle first, endX's second (Brush.js render order) — leftward
    // to shrink the visible window from the right. This is the one drag
    // direction that's guaranteed to change something regardless of whether
    // the default window (last 72 buckets) already covers the WHOLE series
    // (this fixture has ~69 hourly buckets, under 72, so the default window
    // starts already at index 0 — there's no further left to reveal by
    // dragging the whole window, only by narrowing the right edge).
    const endTraveller = page.locator('.recharts-brush-traveller').nth(1);
    const box = await endTraveller.boundingBox();
    if (!box) throw new Error('brush end traveller has no bounding box');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 15; i++) {
      await page.mouse.move(startX - (400 * i) / 15, startY, { steps: 2 });
    }
    await page.mouse.up();

    await expect.poll(
      async () => page.locator('.recharts-bar-rectangle').count(),
      { message: 'expected fewer visible bars after narrowing the brush window' },
    ).toBeLessThan(barCountBefore);

    const ticksAfter = await page.locator('.recharts-xAxis-tick-labels text').allTextContents();
    expect(ticksAfter, 'expected x-axis tick labels to change after dragging the brush').not.toEqual(ticksBefore);
  });
});

test.describe('Explore "Other" fold-in segment (Task 10 step 4)', () => {
  test('folded-out group values render as a distinct, legend-labeled Other segment', async ({ page }) => {
    await gotoExploreHourly(page);

    // Group=Tool + Top=5 against this fixture's tool mix (Task/Bash/Edit/
    // Grep/Read top-5, plus overflow) is known — via manual verification
    // against this same seeded fixture — to produce a non-empty Other fold.
    // Each pivot change fires its own /api/explore fetch; changing Group and
    // then TopN back-to-back without waiting for the first to land races two
    // fetches against each other (SWR's cache can resolve them out of order),
    // so explicitly wait for each response before triggering the next change.
    await page.locator('.pivot button.pv:has-text("Group Model")').click();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/explore') && r.url().includes('group=tool')),
      page.locator('.menu-pop .menu-item:has-text("Tool")').click(),
    ]);
    await page.locator('.pivot button.pv:has-text("Top 10")').click();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/explore') && r.url().includes('topN=5')),
      page.locator('.menu-pop .menu-item:text-is("5")').click(),
    ]);
    await expect(page.locator('.recharts-bar-rectangle')).not.toHaveCount(0);

    // The legend (not just the Detail table) names the fold explicitly.
    await expect(page.locator('.legend')).toContainText('in Other');

    // The Other series' bar fill is the neutral `--ink-3` token, never a
    // rotating categorical hue — color follows the entity, and "Other" is a
    // fold-in, not an identity (dataviz skill's categorical-color rule).
    await expect.poll(async () => page.evaluate(() => {
      const bars = [...document.querySelectorAll('.recharts-bar')];
      const other = bars.find((g) => g.querySelector('.recharts-rectangle')?.getAttribute('name') === 'Other');
      return other?.querySelector('.recharts-rectangle')?.getAttribute('fill') ?? null;
    }), { message: 'expected an Other-named bar series with fill var(--ink-3)' }).toBe('var(--ink-3)');
  });
});

test.describe('Explore session group (Task 16)', () => {
  test('Group=Session renders the Detail table, and clicking a row opens that session', async ({ page }) => {
    await page.goto(`${state.baseURL}/`);
    await page.locator('.tabs button:has-text("Explore")').click();
    await page.locator('.rangebar button:has-text("All")').click();

    await page.locator('.pivot button.pv:has-text("Group Model")').click();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/explore') && r.url().includes('group=session')),
      page.locator('.menu-pop .menu-item:text-is("Session")').click(),
    ]);

    // Detail table renders at least one session row (the seeded big-fixture
    // session, test/e2e/helpers.ts `state.sessionId`).
    const firstRow = page.locator('.card table.tbl tbody tr').first();
    await expect(firstRow).toBeVisible();
    await expect(firstRow).toHaveClass(/rowlink/);

    await firstRow.click();
    await expect(page).toHaveURL(new RegExp(`/session/${state.sessionId}$`));
    await expect(page.locator('.session-view')).toBeVisible();
  });
});
