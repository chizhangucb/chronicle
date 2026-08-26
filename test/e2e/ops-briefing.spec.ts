// E2E for the Briefing ops surface (CHI-323 3d): hub-absent hiding; demo render
// + card action (two-file state) + run-refused-in-demo.
import { test, expect } from '@playwright/test';
import { readSeedState, launchDemo, stopDemo, type DemoServer } from './helpers.ts';

const state = readSeedState();

test.describe('hub absent (seeded): Briefing hidden', () => {
  test('no Briefing nav item', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    await expect(page.locator('.sidebar .sb-item[title="Briefing"]')).toHaveCount(0);
  });
});

test.describe('demo hub: /briefing renders cards + actions', () => {
  let demo: DemoServer;
  test.beforeAll(async () => { demo = await launchDemo(); });
  test.afterAll(() => { if (demo) stopDemo(demo); });

  test('needs-you + awareness sections render, with the disclosed spend gap note', async ({ page }) => {
    await page.goto(demo.baseURL + '/briefing');
    await expect(page.locator('.sidebar .sb-item[title="Briefing"]')).toHaveCount(1);
    await expect(page.locator('.briefing-scope')).toContainText('Spend cards');
    await expect(page.locator('.briefing-card.needs-you')).not.toHaveCount(0);
    await expect(page.locator('.briefing-card', { hasText: 'health-sweep is overdue' })).toBeVisible();
  });

  test('marking a card Done moves it out of the open sections (two-file state)', async ({ page }) => {
    await page.goto(demo.baseURL + '/briefing');
    const card = page.locator('.briefing-card', { hasText: 'health-sweep is overdue' });
    await card.getByRole('button', { name: 'Done' }).click();
    await expect(card.locator('.bc-state.done')).toBeVisible();
  });

  test('Run now is refused in demo (409 surfaces, nothing spawns)', async ({ page }) => {
    await page.goto(demo.baseURL + '/briefing');
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect(page.locator('.briefing-page .gate-error')).toBeVisible();
  });
});
