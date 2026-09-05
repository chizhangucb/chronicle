// E2E for the local-only view log (CHI-325 3a).
//
// This spec is unusual and deliberately so: the Playwright harness IS an agent,
// so "does the actor tagging work" is answerable by asking whether THIS run
// tagged itself correctly. A regression that starts calling automated traffic
// human fails here without any mocking.
//
// Two regimes:
//   seeded (CHRONICLE_E2E=1)  -> rows are written, every one tagged agent
//   demo   (CHRONICLE_DEMO=1) -> no rows at all, because demo is not usage
import { test, expect } from '@playwright/test';
import { readSeedState, launchDemo, stopDemo, type DemoServer } from './helpers.ts';

const state = readSeedState();

// A row is OPENED on arrival and its dwell filled in on departure, so a visit
// is on the books as soon as the surface is reached (see server/viewlog.ts for
// why the count must not depend on the close surviving a page teardown).
async function summary(page: import('@playwright/test').Page, baseURL: string) {
  const res = await page.request.get(baseURL + '/api/view-log/summary');
  expect(res.ok()).toBeTruthy();
  return res.json();
}

// Clearing is a MUTATING route, so it needs the per-boot gate token exactly
// like every other write in the app (server/api.ts mounts gateTokenGuard on
// every non-GET). Same pattern as ops-safety.spec.ts / ask.spec.ts.
async function clearLog(page: import('@playwright/test').Page, baseURL: string) {
  const { token } = await (await page.request.get(baseURL + '/api/gate/token')).json();
  return page.request.delete(baseURL + '/api/view-log', { headers: { 'x-gate-token': token } });
}

test.describe('seeded: navigation is recorded and tagged agent', () => {
  test('this Playwright run tags itself as an agent, never as the operator', async ({ page }) => {
    await clearLog(page, state.baseURL);

    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    await page.goto(state.baseURL + '/projects');
    await expect(page.locator('.projects-page, .page')).toBeVisible();
    // Leaving /projects closes its row too, so both surfaces are on the books.
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();

    await expect.poll(async () => (await summary(page, state.baseURL)).rows, { timeout: 10_000 })
      .toBeGreaterThan(0);

    const s = await summary(page, state.baseURL);
    // The whole point: an automated run must not read as the operator.
    expect(s.humanRows).toBe(0);
    expect(s.agentRows).toBe(s.rows);
    // Routes are stored as PATTERNS. Nothing that looks like a session id or a
    // numeric project id may appear, or the table has become a second copy of
    // the history.
    for (const r of s.routes) {
      expect(r.route).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(r.route).not.toMatch(/^\/project\/\d+/);
    }
    expect(s.routes.map((r: { route: string }) => r.route)).toContain('/');
  });

  test('the hub tab is recorded, so "lives in Spend" is distinguishable from "opened /"', async ({ page }) => {
    await clearLog(page, state.baseURL);
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    await page.goto(state.baseURL + '/?tab=spend');
    await expect(page.locator('.home-dashboard')).toBeVisible();
    await page.goto(state.baseURL + '/projects');

    await expect.poll(async () => (await summary(page, state.baseURL)).rows, { timeout: 10_000 })
      .toBeGreaterThan(1);
    const home = (await summary(page, state.baseURL)).routes.find((r: { route: string }) => r.route === '/');
    // Arriving at / is a visit; the tab move within / is its own row. If the
    // route only ever recorded tab rows, / would vanish from this ranking.
    expect(home.agentVisits).toBeGreaterThan(0);
  });

  test('Clear empties the log', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await page.goto(state.baseURL + '/projects');
    await expect.poll(async () => (await summary(page, state.baseURL)).rows, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const del = await clearLog(page, state.baseURL);
    expect(del.ok()).toBeTruthy();
    expect((await summary(page, state.baseURL)).rows).toBe(0);
  });
});

test.describe('seeded: the log is behind the same write gate as everything else', () => {
  test('an untokened DELETE is refused', async ({ page }) => {
    const res = await page.request.delete(state.baseURL + '/api/view-log');
    expect(res.status()).toBe(403);
  });
});

test.describe('demo: usage is never recorded', () => {
  let demo: DemoServer;
  test.beforeAll(async () => { demo = await launchDemo(); });
  test.afterAll(() => { if (demo) stopDemo(demo); });

  test('navigating a demo console writes zero rows', async ({ page }) => {
    await page.goto(demo.baseURL + '/');
    await page.goto(demo.baseURL + '/safety');
    await page.goto(demo.baseURL + '/');
    // Not "eventually zero": zero, always. Demo usage is not usage, and it is
    // dropped at write time rather than filtered at read time.
    expect((await summary(page, demo.baseURL)).rows).toBe(0);
  });
});
