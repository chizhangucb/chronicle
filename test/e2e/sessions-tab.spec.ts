// E2E drift-pins for the `/?tab=sessions` Sessions tab (CHI-324 2g). Guards the
// signed shape: a [human|all] toggle, three-up aggregates, and ONE flat sessions
// table (no day sub-headers — day grouping stays ledger-only).
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

async function gotoSessions(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/?tab=sessions');
  await expect(page.locator('.home-dashboard .tabs .tab.on')).toHaveText('Sessions');
  await expect(page.locator('.sessions-hub')).toBeVisible();
}

test('Sessions tab header has a [human | all] toggle, human default', async ({ page }) => {
  await gotoSessions(page);
  const opts = page.locator('.sessions-hub .sh-head .st-opt');
  await expect(opts).toHaveText(['human', 'all']);
  await expect(page.locator('.sessions-hub .sh-head .st-opt.on')).toHaveText('human');
});

test('Sessions tab: three-up aggregates + one flat sessions table (no day sub-headers)', async ({ page }) => {
  await gotoSessions(page);
  // grid3 aggregates: busiest days / busiest projects / automation by job.
  await expect(page.locator('.sessions-hub .grid3 .card')).toHaveCount(3);
  // The sessions table is flat — day-grouping (a `.day-head` sub-header) stays
  // ledger-only (/projects), never here.
  await expect(page.locator('.sessions-hub .day-head')).toHaveCount(0);
  await expect(page.locator('.sessions-hub .sh-sessions-table')).toBeVisible();
});

test('Sessions table sort chips are [cost | duration | recent], cost default', async ({ page }) => {
  await gotoSessions(page);
  const chips = page.locator('.sessions-hub .sh-tablehead .st-opt');
  await expect(chips).toHaveText(['cost', 'duration', 'recent']);
  await expect(page.locator('.sessions-hub .sh-tablehead .st-opt.on')).toHaveText('cost');
});
