// E2E for /ask: the guard is server-side, so these pins hold on CI
// (no claude binary) as strongly as locally. Default seeded harness: Ask is OFF
// (toggle default off) so there is NO `∴ Ask` entry and the route fails soft.
// Demo: POST /api/ask is refused with 409 like every runner. The gating FORMULA
// (enabled === toggleOn && claudePresent && !demo) is asserted so it can't drift.
import { test, expect, readSeedState, launchDemo, stopDemo, type DemoServer } from './helpers.ts';

const state = readSeedState();

interface AskStatus { enabled: boolean; toggleOn: boolean; claudePresent: boolean; demo: boolean }

test.describe('ask disabled by default (seeded): no entry, route soft-fails', () => {
  test('no ∴ Ask sidebar entry and /ask/status is disabled', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    await expect(page.locator('.sidebar .ask-item')).toHaveCount(0);

    const status: AskStatus = await (await page.request.get(state.baseURL + '/api/ask/status')).json();
    expect(status.toggleOn).toBe(false);
    expect(status.enabled).toBe(false);
    // The gating formula must never drift.
    expect(status.enabled).toBe(status.toggleOn && status.claudePresent && !status.demo);
  });

  test('navigating to /ask fails soft (no crash, a clear message)', async ({ page }) => {
    await page.goto(state.baseURL + '/ask');
    await expect(page.locator('.ask-page')).toHaveCount(0);
    await expect(page.locator('.page.center.muted')).toContainText('Ask is not available');
  });
});

test.describe('demo mode: /ask is refused', () => {
  let demo: DemoServer;
  test.beforeAll(async () => { demo = await launchDemo(); });
  test.afterAll(() => { if (demo) stopDemo(demo); });

  test('POST /api/ask returns 409 (nothing spawns)', async ({ page }) => {
    const { token } = await (await page.request.get(demo.baseURL + '/api/write-token')).json();
    const res = await page.request.post(demo.baseURL + '/api/ask', {
      headers: { 'x-chronicle-write-token': token, 'Content-Type': 'application/json' },
      data: { question: 'which mcp server cost most?', costMode: 'list' },
    });
    expect(res.status()).toBe(409);

    const status: AskStatus = await (await page.request.get(demo.baseURL + '/api/ask/status')).json();
    expect(status.demo).toBe(true);
    expect(status.enabled).toBe(false); // demo can never enable Ask
    await expect(page.locator('.sidebar .ask-item')).toHaveCount(0);
  });
});
