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

  test('the confidential drill-down is 403 (hard-gated, never served by default)', async ({ page }) => {
    const res = await page.request.get(demo.baseURL + '/api/hub/safety/confidential');
    expect(res.status()).toBe(403);
  });

  test('the gap launcher refuses demo (409)', async ({ page }) => {
    // needs the gate token like any write; fetch it, then POST.
    const token = (await (await page.request.get(demo.baseURL + '/api/gate/token')).json()).token;
    const res = await page.request.post(demo.baseURL + '/api/launch/gap', {
      headers: { 'content-type': 'application/json', 'x-gate-token': token },
      data: { id: 'spend-caps-unset' },
    });
    expect(res.status()).toBe(409);
  });
});
