// E2E for the Jobs ops surface (CHI-323 3c): hub-absent hiding on the seeded
// server; the unified job list + log-tail drill-in on a demo server.
import { test, expect } from '@playwright/test';
import { readSeedState, launchDemo, stopDemo, type DemoServer } from './helpers.ts';

const state = readSeedState();

test.describe('hub absent (seeded): Jobs hidden', () => {
  test('no Jobs nav item; /api/hub/jobs returns the absent sentinel', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    await expect(page.locator('.sidebar .sb-item[title="Jobs"]')).toHaveCount(0);
    expect(await (await page.request.get(state.baseURL + '/api/hub/jobs')).json()).toEqual({ hubPresent: false });
  });
});

test.describe('demo hub: /jobs lists jobs + tails a log', () => {
  let demo: DemoServer;
  test.beforeAll(async () => { demo = await launchDemo(); });
  test.afterAll(() => { if (demo) stopDemo(demo); });

  test('the unified job list renders with status badges and a not-installed template', async ({ page }) => {
    await page.goto(demo.baseURL + '/jobs');
    await expect(page.locator('.sidebar .sb-item[title="Jobs"]')).toHaveCount(1);
    await expect(page.locator('.jobs-table tbody tr')).toHaveCount(5);
    await expect(page.locator('.job-badge.not-installed')).not.toHaveCount(0);
    await expect(page.locator('.job-badge.stale')).not.toHaveCount(0);
  });

  test('the log drill-in tails the declared log', async ({ page }) => {
    await page.goto(demo.baseURL + '/jobs');
    await page.locator('.jobs-row', { hasText: 'com.chronicle.daily-digest' }).getByRole('button', { name: 'Log' }).click();
    await expect(page.locator('.jobs-log-body')).toBeVisible();
    await expect(page.locator('.jobs-log-body')).toContainText('daily-digest run');
  });

  test('pause is refused in demo (gate inert) — a 409 surfaces, nothing pauses', async ({ page }) => {
    await page.goto(demo.baseURL + '/jobs');
    await page.locator('.jobs-row', { hasText: 'com.chronicle.daily-digest' }).getByRole('button', { name: 'Pause' }).click();
    // demo gate refuses the propose; the page shows the error, no confirm card opens.
    await expect(page.locator('.jobs-page .gate-error')).toBeVisible();
    await expect(page.locator('.gate-dialog')).toHaveCount(0);
  });
});
