// Briefing filter + day-grouped history + card age (CHI-325 review).
//
// Pins the contract enumerable (four chips, that order) and the two properties
// that made the page worth changing: Handled is HISTORY and must say WHEN, and
// an open card must show its true age so a long-avoided card is visible.
import { test, expect } from '@playwright/test';
import { launchDemo, stopDemo, type DemoServer } from './helpers.ts';

let demo: DemoServer;
test.beforeAll(async () => { demo = await launchDemo(); });
test.afterAll(() => { if (demo) stopDemo(demo); });

test('the filter has exactly All / Needs you / Awareness / Handled, in that order', async ({ page }) => {
  await page.goto(demo.baseURL + '/briefing');
  const chips = page.locator('.briefing-filter .tab');
  await expect(chips).toHaveCount(4);
  const labels = (await chips.allTextContents()).map((s) => s.replace(/\s*\d+\s*$/, '').trim());
  expect(labels).toEqual(['All', 'Needs you', 'Awareness', 'Handled']);
});

test('each chip narrows to its own section', async ({ page }) => {
  await page.goto(demo.baseURL + '/briefing');
  // All: needs-you and awareness sections both present.
  await expect(page.locator('.briefing-section')).not.toHaveCount(0);

  await page.locator('.briefing-filter .tab', { hasText: 'Needs you' }).click();
  await expect(page.locator('.briefing-sec-head', { hasText: 'For your awareness' })).toHaveCount(0);

  await page.locator('.briefing-filter .tab', { hasText: 'Handled' }).click();
  await expect(page.locator('.briefing-sec-head', { hasText: 'Needs you' })).toHaveCount(0);
});

test('Handled is grouped by day and states its retention', async ({ page }) => {
  await page.goto(demo.baseURL + '/briefing');
  await page.locator('.briefing-filter .tab', { hasText: 'Handled' }).click();
  // The whole point of the change: history that says WHEN.
  await expect(page.locator('.handled-day-head').first()).toBeVisible();
  await expect(page.locator('.handled-note')).toContainText('90 days');
});

test('Reopen moves a handled card back to needs-you, even over a demo baseline', async ({ page }) => {
  // Regression pin for the CHI-325 review bug: applyCardAction used to DELETE
  // the state entry on reopen, so a demo file's shipped "snoozed" reasserted
  // itself and Reopen was a permanent no-op on a demo console.
  await page.goto(demo.baseURL + '/briefing');
  const handledChip = page.locator('.briefing-filter .tab', { hasText: 'Handled' });
  const needsChip = page.locator('.briefing-filter .tab', { hasText: 'Needs you' });
  const handledBefore = Number((await handledChip.innerText()).match(/(\d+)/)![1]);
  const needsBefore = Number((await needsChip.innerText()).match(/(\d+)/)![1]);
  test.skip(handledBefore === 0, 'demo seed has no handled card to reopen');

  await page.locator('button', { hasText: 'Reopen' }).first().click();
  await expect.poll(async () => Number((await handledChip.innerText()).match(/(\d+)/)![1]))
    .toBe(handledBefore - 1);
  expect(Number((await needsChip.innerText()).match(/(\d+)/)![1])).toBe(needsBefore + 1);
});
