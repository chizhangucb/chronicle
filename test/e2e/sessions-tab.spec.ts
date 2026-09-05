// E2E drift-pins for the `/?tab=sessions` Sessions tab. Guards the
// signed shape: a session count, two-up aggregates, and ONE flat sessions
// table (no day sub-headers — day grouping stays ledger-only).
import { type Page } from '@playwright/test';
import { test, expect, readSeedState } from './helpers.ts';

const state = readSeedState();

async function gotoSessions(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/?tab=sessions');
  await expect(page.locator('.home-dashboard .tabs .tab.on')).toHaveText('Sessions');
  await expect(page.locator('.sessions-tab')).toBeVisible();
}

test('Sessions tab: two-up aggregates + one flat sessions table (no day sub-headers)', async ({ page }) => {
  await gotoSessions(page);
  // grid2b aggregates: busiest days / busiest projects.
  await expect(page.locator('.sessions-tab .grid2b .card')).toHaveCount(2);
  // The proxy lane and the automation split are gone (#217).
  await expect(page.locator('.sessions-tab .sh-head .st-opt')).toHaveCount(0);
  // The sessions table is flat — day-grouping (a `.day-head` sub-header) stays
  // ledger-only (/projects), never here.
  await expect(page.locator('.sessions-tab .day-head')).toHaveCount(0);
  await expect(page.locator('.sessions-tab .sh-sessions-table')).toBeVisible();
});

test('Sessions table sort chips are [cost | duration | recent], cost default', async ({ page }) => {
  await gotoSessions(page);
  const chips = page.locator('.sessions-tab .sh-tablehead .st-opt');
  await expect(chips).toHaveText(['cost', 'duration', 'recent']);
  await expect(page.locator('.sessions-tab .sh-tablehead .st-opt.on')).toHaveText('cost');
});
