// First E2E smoke suite (spec §5.1 / task-6): function, overflow, data-scale,
// and a perf floor, all driven against the seeded big fixture (120 subagents,
// 5000 messages — see helpers.ts / test/fixtures/gen-big-session.mjs).
//
// Flake discipline: every wait is on a visible DOM condition
// (`expect(locator).toBeVisible()`/`toContainText()` auto-retry) or an
// explicit `expect.poll` for the one non-DOM assertion (the perf floor) —
// never a bare `page.waitForTimeout`/sleep.
import { type Page } from '@playwright/test';
import { test, expect, readSeedState, WIDTHS } from './helpers.ts';

const state = readSeedState();

async function gotoHome(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/');
  // The recent-sessions ledger (`.day .row`) moved to /projects (2026-08-14
  // feedback round, D1) — Home now ends at the Insights charts.
  await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
}

async function gotoProjects(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/projects');
  await expect(page.locator('.day .row').first()).toBeVisible();
}

async function gotoFixtureOverview(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/session/${encodeURIComponent(state.sessionId)}`);
  await expect(page.getByRole('heading', { name: /Files touched/ })).toBeVisible();
}

test('projects renders at least one session row from the fixture', async ({ page }) => {
  await gotoProjects(page);
  const rowCount = await page.locator('.day .row').count();
  expect(rowCount).toBeGreaterThanOrEqual(1);
});

// Permanent data-scale guard (Task 2): the fixture has exactly
// FIXTURE_SUBAGENT_COUNT=120 subagent runs, and the Overview Subagents card
// header must show the RUN count, not the (5) distinct agent_type count.
test('fixture session Overview Subagents card shows the run count (120)', async ({ page }) => {
  await gotoFixtureOverview(page);
  const heading = page.getByRole('heading', { name: /Subagents/ });
  await expect(heading).toBeVisible();
  await expect(heading).toContainText('120');
});

// D3 (Task 11): the Subagents card's two-level drill-in. Clicking a type row
// opens a RUN LIST (one row per agent_id) — the fixture's 120 runs spread
// across only 5 agent_types, so any type row's run list must show more than
// one distinct run (guards against the drill-in regressing back to showing
// one row per TYPE, which is exactly the bug this task fixed).
test('Subagents card drill-in opens a run list with more than one distinct run', async ({ page }) => {
  await gotoFixtureOverview(page);
  const firstRow = page.locator('.subagent-row').first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();

  const runRows = page.locator('.rowlink');
  await expect(runRows.first()).toBeVisible();
  const rowCount = await runRows.count();
  expect(rowCount, 'run list must show more than one run for the clicked agent_type').toBeGreaterThan(1);

  // Drilling into one run switches to that run's transcript (agent_id
  // filter), not a whole-type dump.
  await runRows.first().click();
  await expect(page.locator('.subagent-conv')).toBeVisible();
});

test('global search returns a hit', async ({ page }) => {
  await gotoHome(page);
  await page.locator('button.icon-btn[title^="Search"]').click();
  await expect(page.locator('.search-modal')).toBeVisible();
  await page.locator('.search-input').fill('fixture');
  const resultRows = page.locator('.search-row');
  await expect(resultRows.first()).toBeVisible();
  expect(await resultRows.count()).toBeGreaterThanOrEqual(1);
});

for (const width of WIDTHS) {
  test(`no horizontal overflow at ${width}px — Home`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoHome(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(overflow, `documentElement.scrollWidth exceeds innerWidth at ${width}px on Home`).toBe(true);
  });

  test(`no horizontal overflow at ${width}px — session Overview`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoFixtureOverview(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    );
    expect(overflow, `documentElement.scrollWidth exceeds innerWidth at ${width}px on session Overview`).toBe(true);
  });
}

// Perf budget FLOOR (tighten later, per the brief — this only guards against
// gross regressions): warm /api/insights must respond well under 500ms. The
// server result cache (Task 3) makes this generous once warm; hit it once
// to populate the cache, then time the second request.
test('warm /api/insights responds under 500ms', async ({ request }) => {
  const first = await request.get(`${state.baseURL}/api/insights`);
  expect(first.ok()).toBe(true);

  const startedAt = Date.now();
  const second = await request.get(`${state.baseURL}/api/insights`);
  const elapsedMs = Date.now() - startedAt;

  expect(second.ok()).toBe(true);
  expect(elapsedMs, `warm /api/insights took ${elapsedMs}ms`).toBeLessThan(500);
});
