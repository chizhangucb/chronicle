// E2E for the Modules ops surface + the hub-conditional nav enumerable
// (CHI-323 3a). Two regimes:
//   - the seeded server is hub-ABSENT, so the ops nav is hidden and
//     /api/hub/modules returns the absent sentinel (the guard the contract names);
//   - a DEMO server (synthetic hub) renders /modules against generic-fictional
//     data (the render coverage a hub-absent run can't give). The 1h demo walk
//     screenshots this; here we assert structure.
import { test, expect } from '@playwright/test';
import { readSeedState, launchDemo, stopDemo, type DemoServer } from './helpers.ts';

const state = readSeedState();

test.describe('hub absent (seeded): ops nav hidden', () => {
  test('the Modules nav item is not rendered and the API returns the absent sentinel', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    // sb-top stays exactly Insights + Projects (the home.spec pin) — no ops items.
    await expect(page.locator('.sidebar .sb-top .sb-item')).toHaveCount(2);
    await expect(page.locator('.sidebar .sb-item[title="Modules"]')).toHaveCount(0);
    const res = await page.request.get(state.baseURL + '/api/hub/modules');
    expect(res.ok()).toBeTruthy();
    expect(await res.json()).toEqual({ hubPresent: false });
  });
});

test.describe('demo hub: /modules renders synthetic registry', () => {
  let demo: DemoServer;
  test.beforeAll(async () => { demo = await launchDemo(); });
  test.afterAll(() => { if (demo) stopDemo(demo); });

  test('ops nav shows Modules and the page lists the synthetic modules with a contract detail', async ({ page }) => {
    await page.goto(demo.baseURL + '/modules');
    // Ops nav item is present in demo mode.
    await expect(page.locator('.sidebar .sb-item[title="Modules"]')).toHaveCount(1);
    // The registry table renders the synthetic rows (atlas, ledger, beta).
    const rows = page.locator('.modules-table tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('.modules-name', { hasText: 'atlas' })).toBeVisible();
    // Selecting a module with a full contract shows its snapshotted markdown.
    await rows.first().click();
    await expect(page.locator('.modules-detail .modules-contract')).toBeVisible();
    await expect(page.locator('.modules-detail .modules-contract')).toContainText('module contract');
  });

  test('the hub status endpoint reports demo mode', async ({ page }) => {
    const res = await page.request.get(demo.baseURL + '/api/hub/status');
    expect((await res.json()).mode).toBe('demo');
  });
});
