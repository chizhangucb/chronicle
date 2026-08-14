// E2E for `/projects` (F2 restore, 2026-08-13): the shipped bordered
// card-grid was an unagreed redesign. This suite pins the Chi-confirmed
// contract instead — a dense rail-style LIST reusing the exact pre-Batch-C
// `.rail-proj` row anatomy (pdot · name · optional live dot … session count
// · gear menu, meta line = branch/"needs association" · relative time) —
// and guards against the invented `.projects-grid` card treatment ever
// coming back.
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

async function gotoProjects(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/projects');
  await expect(page.locator('.projects-page .rail-proj').first()).toBeVisible();
}

test('renders rail-style rows, not the old bordered card grid', async ({ page }) => {
  await gotoProjects(page);
  const rows = page.locator('.projects-page .rail-proj');
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(1);

  // The row anatomy: colored pdot, name, session count, gear menu, meta line.
  const first = rows.first();
  await expect(first.locator('.pdot')).toBeVisible();
  await expect(first.locator('.n .c')).toBeVisible();
  await expect(first.locator('button.gear')).toBeVisible();
  await expect(first.locator('.meta')).toBeVisible();

  // Regression guard: the invented card-grid class/container must never
  // reappear (grep-level check done at review time; this is the runtime
  // twin — it fails loudly if a future edit reintroduces the card grid).
  await expect(page.locator('.projects-grid')).toHaveCount(0);
});

test('project row is NOT rendered as a bordered card (no permanent border/background beyond the shared .rail-proj hover styling)', async ({ page }) => {
  await gotoProjects(page);
  const row = page.locator('.projects-page .rail-proj').first();
  const style = await row.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { borderColor: cs.borderColor, borderStyle: cs.borderStyle };
  });
  // `.rail-proj`'s base rule sets `border: 1px solid transparent` (only
  // turns visible ON HOVER) — never a permanent visible border, which is
  // what the invented `.projects-page .projects-grid .rail-proj` override
  // used to force.
  expect(style.borderStyle).toBe('solid');
  expect(style.borderColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
});

test('gear menu opens with Sync Update / Rename / Remove, and no "View Details"', async ({ page }) => {
  await gotoProjects(page);
  await page.locator('.projects-page .rail-proj').first().locator('button.gear').click();
  const menu = page.locator('.menu-pop');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Sync Update');
  await expect(menu).toContainText('Rename');
  await expect(menu).toContainText('Remove from Chronicle');
  await expect(menu).not.toContainText('View Details');
});

test('meta line shows branch (⎇) or "needs association", plus a relative time', async ({ page }) => {
  await gotoProjects(page);
  const meta = page.locator('.projects-page .rail-proj').first().locator('.meta');
  const text = (await meta.textContent()) ?? '';
  expect(/⎇ |needs association/.test(text)).toBe(true);
});

test('list is single-column at 1024px and flows to two columns at 1728px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await gotoProjects(page);
  const narrowCols = await page.locator('.projects-page .projects-list').evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length || 1,
  );
  expect(narrowCols).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 1728, height: 900 });
  const wideCols = await page.locator('.projects-page .projects-list').evaluate(
    (el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length || 1,
  );
  expect(wideCols).toBeGreaterThanOrEqual(2);
});

test('no horizontal overflow on /projects at 1024/1366/1728', async ({ page }) => {
  for (const width of [1024, 1366, 1728]) {
    await page.setViewportSize({ width, height: 900 });
    await gotoProjects(page);
    const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(ok, `overflow at ${width}px`).toBe(true);
  }
});

test('live session shows a pulsing dot on its project row', async ({ page }) => {
  // Same technique as home.spec.ts's Activity-block live-dot test: open a
  // persistent SSE stream so the server registers a live watcher for the
  // fixture session, which /api/projects then reflects as `live: true` on
  // that project's row.
  await page.goto(state.baseURL + '/');
  await page.evaluate((id) => new Promise<boolean>((resolve) => {
    const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/live`);
    (window as unknown as { __es?: EventSource }).__es = es;
    es.onmessage = () => resolve(true);
    es.onopen = () => resolve(true);
    setTimeout(() => resolve(true), 3000);
  }), state.sessionId);
  await expect.poll(async () => {
    const r = await page.request.get(`${state.baseURL}/api/live/status`);
    const list = (await r.json()) as { sessionId: string }[];
    return list.some((w) => w.sessionId === state.sessionId);
  }).toBe(true);

  // In-app nav (not page.goto), same reason as home.spec.ts: a full page
  // navigation would tear down the EventSource before /api/projects can see
  // the open watcher.
  await page.locator('button.sb-item[title="Projects"]').click();
  await expect(page.locator('.projects-page .rail-proj').first()).toBeVisible();
  await expect(page.locator('.rail-proj .live-dot.on').first()).toBeVisible();

  await page.evaluate(() => (window as unknown as { __es?: EventSource }).__es?.close());
});
