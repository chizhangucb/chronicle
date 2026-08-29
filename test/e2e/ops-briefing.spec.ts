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

  test('needs-you + awareness sections render, including a spend card (CHI-324 2i)', async ({ page }) => {
    await page.goto(demo.baseURL + '/briefing');
    await expect(page.locator('.sidebar .sb-item[title="Briefing"]')).toHaveCount(1);
    await expect(page.locator('.briefing-card.needs-you')).not.toHaveCount(0);
    await expect(page.locator('.briefing-card', { hasText: 'health-sweep is overdue' })).toBeVisible();
    // The spend domain now lights up (the phase-1 D7 gap closed).
    await expect(page.locator('.briefing-card', { hasText: 'Today’s spend is' }).or(page.locator('.briefing-card', { hasText: "Today's spend is" }))).toBeVisible();
  });

  // CHI-374 pin: the needs-you accent is the dedicated --attention terracotta, NOT
  // the everyday --brass, and the card face carries the faint warm wash that the
  // neutral awareness cards do not. Guards the binary treatment from drifting back
  // into the brand accent.
  test('needs-you cards use the off-brass attention accent, awareness cards do not', async ({ page }) => {
    await page.goto(demo.baseURL + '/briefing');
    const needsYou = page.locator('.briefing-card.needs-you').first();
    await expect(needsYou).toBeVisible();
    const accent = await needsYou.evaluate((el) => {
      const cs = getComputedStyle(el);
      const root = getComputedStyle(document.documentElement);
      return {
        border: cs.borderLeftColor,
        bg: cs.backgroundColor,
        brass: root.getPropertyValue('--brass').trim(),
        attention: root.getPropertyValue('--attention').trim(),
      };
    });
    expect(accent.attention).not.toBe(accent.brass);
    expect(accent.border).toBe('rgb(205, 95, 60)'); // --attention #cd5f3c
    expect(accent.border).not.toBe('rgb(192, 138, 30)'); // --brass #c08a1e

    const plain = page.locator('.briefing-card:not(.needs-you)').first();
    await expect(plain).toBeVisible();
    const plainStyle = await plain.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderLeftColor, bg: cs.backgroundColor };
    });
    expect(plainStyle.border).not.toBe(accent.border);
    expect(plainStyle.bg).not.toBe(accent.bg);
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
