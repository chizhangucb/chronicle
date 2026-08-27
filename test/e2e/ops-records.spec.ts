// E2E for the Records ops surface + its hub-conditional nav (CHI-324 2h).
// Same two regimes as the other ops surfaces: hub-ABSENT (nav hidden, API
// absent-sentinel) and DEMO (synthetic records render).
import { test, expect } from '@playwright/test';
import { readSeedState, launchDemo, stopDemo, type DemoServer } from './helpers.ts';

const state = readSeedState();

test.describe('hub absent (seeded): Records nav hidden', () => {
  test('no Records nav item; /api/hub/records returns the absent sentinel', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    await expect(page.locator('.sidebar .sb-item[title="Records"]')).toHaveCount(0);
    const res = await page.request.get(state.baseURL + '/api/hub/records');
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ hubPresent: false });
  });
});

test.describe('demo hub: /records renders the sessions type', () => {
  let demo: DemoServer;
  test.beforeAll(async () => { demo = await launchDemo(); });
  test.afterAll(() => { if (demo) stopDemo(demo); });

  test('ops nav shows Records; the sessions table lists synthetic rows newest-first', async ({ page }) => {
    await page.goto(demo.baseURL + '/records');
    await expect(page.locator('.sidebar .sb-item[title="Records"]')).toHaveCount(1);
    // The record-type switcher is present with the Sessions type active.
    await expect(page.locator('.records-switcher .tab.on')).toHaveText('Sessions');
    // The table renders the synthetic ledger rows (5 in the demo seed).
    const rows = page.locator('.records-table tbody tr');
    await expect(rows).toHaveCount(5);
    // Newest-first: the first row is the Aug 26 stamp.
    await expect(rows.first().locator('.records-date')).toContainText('2026-08-26');
    // Session ids render as links into /session/:id.
    await expect(rows.first().locator('.records-idlink')).toHaveAttribute('href', /\/session\//);
  });

  test('the repo chips filter the table', async ({ page }) => {
    await page.goto(demo.baseURL + '/records');
    await page.locator('.records-chips .chip', { hasText: 'hub' }).click();
    // Only the two hub-repo rows remain (the demo seed has 2 hub + 3 chronicle).
    await expect(page.locator('.records-table tbody tr')).toHaveCount(2);
  });
});
