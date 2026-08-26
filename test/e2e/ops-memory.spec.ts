// E2E for the Memory ops surface / V2 Nebula (CHI-323 3e). WebGL pixels are not
// asserted (headless GL is unreliable; the release walk runs a software-GL pass);
// this pins the shell + API + that the canvas mounts with NO page/console errors.
// Chromium runs with swiftshader so the WebGL context initializes headless.
import { test, expect } from '@playwright/test';
import { readSeedState, launchDemo, stopDemo, type DemoServer } from './helpers.ts';

// Software WebGL so the three.js canvas initializes in headless chromium (no GPU
// in CI). Pixels are still not asserted (swiftshader output is unreliable to
// capture) — only that the context comes up and the component does not crash.
test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] } });

const state = readSeedState();

test.describe('hub absent (seeded): Memory hidden', () => {
  test('no Memory nav item; /api/hub/memory absent sentinel', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    await expect(page.locator('.sidebar .sb-item[title="Memory"]')).toHaveCount(0);
    expect(await (await page.request.get(state.baseURL + '/api/hub/memory')).json()).toEqual({ hubPresent: false });
  });
});

test.describe('demo hub: /memory mounts the Nebula shell', () => {
  let demo: DemoServer;
  test.beforeAll(async () => { demo = await launchDemo(); });
  test.afterAll(() => { if (demo) stopDemo(demo); });

  test('shell renders (header + scope + canvas) with no page errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(demo.baseURL + '/memory');
    await expect(page.locator('.sidebar .sb-item[title="Memory"]')).toHaveCount(1);
    await expect(page.locator('.memory-head')).toContainText('notes');
    await expect(page.locator('.memory-scope')).toContainText('rot threshold');
    // the lazy three.js chunk mounts a canvas
    await expect(page.locator('.memory-canvas-wrap canvas')).toHaveCount(1, { timeout: 15_000 });
    expect(errors, `page errors on /memory: ${errors.join(' | ')}`).toEqual([]);
  });

  test('/api/hub/memory returns nodes/links with no confidential content', async ({ page }) => {
    const body = await (await page.request.get(demo.baseURL + '/api/hub/memory')).json();
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(Array.isArray(body.links)).toBeTruthy();
    // demo is synthetic; nothing from a real hub
    expect(JSON.stringify(body)).not.toMatch(/chizhang/i);
  });

  test('open-file is refused in demo (409)', async ({ page }) => {
    const token = (await (await page.request.get(demo.baseURL + '/api/gate/token')).json()).token;
    const res = await page.request.post(demo.baseURL + '/api/open-file', {
      headers: { 'content-type': 'application/json', 'x-gate-token': token }, data: { path: 'wiki/atlas.md' },
    });
    expect(res.status()).toBe(409);
  });
});
