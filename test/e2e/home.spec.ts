// Task 13 E2E: the new `/` Insights-overview dashboard. Asserts the reading
// order (dashboard zone THEN the reused Recent-sessions ledger), the dashboard
// zone stays compact, the window toggle hides the Activity block off "Today",
// the live dot renders for a live session, and the ledger still renders/scrolls.
//
// Flake discipline: every wait is on a visible DOM condition (auto-retrying
// `expect`), never a bare sleep.
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

async function gotoHome(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/');
  // Dashboard zone + the ledger both present.
  await expect(page.locator('.home-dash')).toBeVisible();
  await expect(page.locator('.recent-ledger .day .row').first()).toBeVisible();
}

test('reading order: dashboard zone renders before the Recent-sessions ledger', async ({ page }) => {
  await gotoHome(page);
  const order = await page.evaluate(() => {
    const dash = document.querySelector('.home-dash');
    const ledger = document.querySelector('.recent-ledger');
    if (!dash || !ledger) return 'missing';
    // eslint-disable-next-line no-bitwise
    return (dash.compareDocumentPosition(ledger) & Node.DOCUMENT_POSITION_FOLLOWING) ? 'ledger-after' : 'ledger-before';
  });
  expect(order).toBe('ledger-after');
});

test('dashboard zone height stays within 1.2 viewport heights at 1366', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await gotoHome(page);
  // Wait for the KPI strip so the zone is at full height before measuring.
  await expect(page.locator('.home-dash .kpis')).toBeVisible();
  const h = await page.locator('.home-dash').evaluate((el) => el.getBoundingClientRect().height);
  expect(h, `dashboard zone is ${h}px, over 1.2×900`).toBeLessThanOrEqual(900 * 1.2);
});

test('no horizontal overflow on the dashboard at 1366', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await gotoHome(page);
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(ok).toBe(true);
});

test('window toggle to 7d hides the Activity block', async ({ page }) => {
  await gotoHome(page);
  // Activity block present on the default Today window.
  await expect(page.locator('.activity-card')).toBeVisible();
  await page.locator('.home-dashboard .rangebar button', { hasText: /^7d$/ }).click();
  await expect(page.locator('.activity-card')).toHaveCount(0);
  // Burn tile stays (it is meaningful on every window).
  await expect(page.locator('.burn-card')).toBeVisible();
});

test('live session shows a pulsing dot in the Activity block', async ({ page }) => {
  await gotoHome(page);
  // Open a persistent SSE stream in-page → the server registers a live watcher
  // for the fixture session, so /api/activity marks it live regardless of its
  // (old) stored ended_at. The EventSource lives on `window`, so it survives
  // SPA navigation; remounting the dashboard refetches activity and sees it.
  await page.evaluate((id) => new Promise<boolean>((resolve) => {
    const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/live`);
    (window as unknown as { __es?: EventSource }).__es = es;
    es.onmessage = () => resolve(true); // server sends a status event immediately
    es.onopen = () => resolve(true);
    setTimeout(() => resolve(true), 3000);
  }), state.sessionId);
  // Confirm the server registered the watcher before remounting.
  await expect.poll(async () => {
    const r = await page.request.get(`${state.baseURL}/api/live/status`);
    const list = (await r.json()) as { sessionId: string }[];
    return list.some((w) => w.sessionId === state.sessionId);
  }).toBe(true);

  // Remount HomeDashboard via in-app nav (keeps the EventSource open).
  await page.locator('button.sb-item[title="Projects"]').click();
  await expect(page.locator('.projects-page, .empty-state').first()).toBeVisible();
  await page.locator('button.sb-item[title="Home"]').click();

  await expect(page.locator('.activity-row .live-dot.on').first()).toBeVisible();

  await page.evaluate(() => (window as unknown as { __es?: EventSource }).__es?.close());
});

// The static fixture has a single session, so the append-on-scroll PATH (a 2nd
// 50-row page) can't be exercised here — that's covered by the offset paging
// unit test (test/search-recent.test.mjs). This guards that the ledger still
// renders its rows and scrolling to the bottom doesn't tear it down.
test('ledger renders and survives a scroll to the bottom', async ({ page }) => {
  await gotoHome(page);
  const rows = page.locator('.recent-ledger .day .row');
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
  await page.locator('.home-dashboard').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(rows.first()).toBeVisible();
});
