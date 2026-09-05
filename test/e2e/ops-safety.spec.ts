// E2E for the Safety ops surface (CHI-323 3d). Hub-absent hiding on the seeded
// server; posture + accepted-gaps render, confidential hard-gate (403), and the
// demo-inert gate on a demo server.
import { test, expect } from '@playwright/test';
import { readSeedState, launchDemo, stopDemo, type DemoServer } from './helpers.ts';

const state = readSeedState();

test.describe('hub absent (seeded): Safety hidden', () => {
  test('no Safety nav item; /api/hub/safety returns the absent sentinel', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    await expect(page.locator('.sidebar .sb-item[title="Safety"]')).toHaveCount(0);
    const res = await page.request.get(state.baseURL + '/api/hub/safety');
    expect(await res.json()).toEqual({ hubPresent: false });
  });
});

test.describe('demo hub: /safety renders posture + gaps, writes are inert', () => {
  let demo: DemoServer;
  test.beforeAll(async () => { demo = await launchDemo(); });
  test.afterAll(() => { if (demo) stopDemo(demo); });

  test('posture tiles + accepted-gaps render; gate controls are read-only in demo', async ({ page }) => {
    await page.goto(demo.baseURL + '/safety');
    await expect(page.locator('.sidebar .sb-item[title="Safety"]')).toHaveCount(1);
    await expect(page.locator('.safety-posture .posture-tile')).toHaveCount(4);
    await expect(page.locator('.safety-posture')).toContainText('ENABLED');
    // demo: gate writes disabled, no editable control rows
    await expect(page.locator('.safety-control')).toHaveCount(0);
    // accepted-gaps register renders
    await expect(page.locator('.gap-card')).not.toHaveCount(0);
  });

  // CHI-379: push posture (conditioned-auto push pins) renders read-only,
  // between the posture tiles and the gate controls, with the unbounded
  // owner-rule card and no identity-regex leak.
  test('push posture panel renders pins + the owner-rule card, no scrub-whitelist leak', async ({ page }) => {
    await page.goto(demo.baseURL + '/safety');
    await expect(page.locator('.safety-pushpins .pushpin-card')).not.toHaveCount(0);
    await expect(page.locator('.pushpin-card.owner-rule')).toHaveCount(1);
    const body = await page.locator('.safety-pushpins').innerText();
    expect(body).not.toMatch(/hermes/i);
  });

  // CHI-374 sweep pin: /safety's actionable gap cards carry the off-brass
  // --attention treatment, so "act on this" reads identically app-wide.
  // Watch-only gaps stay neutral.
  test('actionable gap cards use the off-brass attention accent, watch gaps do not', async ({ page }) => {
    await page.goto(demo.baseURL + '/safety');
    const actionable = page.locator('.gap-card.actionable').first();
    if (await actionable.count() === 0) test.skip(true, 'demo fixture has no actionable gap');
    await expect(actionable).toBeVisible();
    const style = await actionable.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderLeftColor, bg: cs.backgroundColor };
    });
    expect(style.border).toBe('rgb(205, 95, 60)'); // --attention #cd5f3c
    expect(style.border).not.toBe('rgb(192, 138, 30)'); // --brass #c08a1e

    const watch = page.locator('.gap-card.watch').first();
    if (await watch.count() > 0) {
      const watchStyle = await watch.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { border: cs.borderLeftColor, bg: cs.backgroundColor };
      });
      expect(watchStyle.border).not.toBe(style.border);
      expect(watchStyle.bg).not.toBe(style.bg);
    }
  });

  test('the confidential drill-down is 403 (hard-gated, never served by default)', async ({ page }) => {
    const res = await page.request.get(demo.baseURL + '/api/hub/safety/confidential');
    expect(res.status()).toBe(403);
  });

});
