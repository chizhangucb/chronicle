// E2E for the merged Home/Insights hub at `/` (product-IA fix, 2026-08-13).
// The old separate `/insights` dashboard is gone: `/` IS the Insights hub, with
// Overview / Explore / Content tabs and a five-option window toggle. This suite
// also carries the DRIFT-PIN tests that would have caught the two-surface
// regression (sidebar entries, tabs, window options, /insights redirect,
// Overview DOM order).
//
// 2026-08-14 feedback round (D1+D2, records/plans/2026-08-14-chronicle-
// feedback-round-plan.md): the sidebar item + page title at `/` were renamed
// Home → Insights (∑ glyph), and the recent-sessions ledger — previously the
// last section of this page — moved to `/projects` (see projects.spec.ts).
// Tests below are retargeted accordingly.
//
// Flake discipline: every wait is on a visible DOM condition (auto-retrying
// `expect`), never a bare sleep.
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

async function gotoHome(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/');
  await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
}

// ── Drift-pin (a): sidebar has exactly Insights + Projects, no Home entry ─────
test('sidebar top nav has exactly Insights and Projects, no Home entry', async ({ page }) => {
  await gotoHome(page);
  const items = page.locator('.sidebar .sb-top .sb-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveAttribute('title', 'Insights');
  await expect(items.nth(1)).toHaveAttribute('title', 'Projects');
  await expect(items.nth(0).locator('.sb-icon')).toHaveText('∑');
  await expect(items.nth(1).locator('.sb-icon')).toHaveText('◫');
  await expect(page.locator('.sidebar .sb-item[title="Home"]')).toHaveCount(0);
  // The old ⌂ Home glyph is gone from the chrome.
  await expect(page.locator('.sidebar')).not.toContainText('⌂');
});

// ── Drift-pin (b): `/` shows exactly the five CHI-324 hub tabs ────────────────
test('the hub at / shows exactly Overview / Explore / Content / Spend / Sessions tabs', async ({ page }) => {
  await gotoHome(page);
  const tabs = page.locator('.home-dashboard .tabs .tab');
  await expect(tabs).toHaveCount(5);
  await expect(tabs).toHaveText(['Overview', 'Explore', 'Content', 'Spend', 'Sessions']);
  // Overview is the default (active) tab.
  await expect(page.locator('.home-dashboard .tabs .tab.on')).toHaveText('Overview');
});

// ── Drift-pin (c): the window toggle has exactly the five options ─────────────
test('the window toggle on / has exactly Today / 7d / 30d / 90d / All', async ({ page }) => {
  await gotoHome(page);
  const opts = page.locator('.home-dashboard .rangebar button');
  await expect(opts).toHaveCount(5);
  await expect(opts).toHaveText(['Today', '7d', '30d', '90d', 'All']);
});

// ── Drift-pin (d): /insights redirects to / (preserving a tab deep-link) ──────
test('/insights redirects to the merged hub at /', async ({ page }) => {
  await page.goto(state.baseURL + '/insights');
  await expect(page).toHaveURL(new RegExp(`${state.baseURL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/$`));
  await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
});

test('/insights?tab=explore redirects to /?tab=explore with the Explore tab active', async ({ page }) => {
  await page.goto(state.baseURL + '/insights?tab=explore');
  await expect(page).toHaveURL(/\/\?tab=explore$/);
  await expect(page.locator('.home-dashboard .tabs .tab.on')).toHaveText('Explore');
  await expect(page.locator('.pivot').first()).toBeVisible();
});

// ── Drift-pin (e): Overview DOM order KPIs → activity → anomaly tile → charts,
// the recent-sessions ledger no longer mounts here (moved to /projects, D1),
// and Top-sessions-by-cost is retired from Overview (CHI-324) ─────────────────
test('Overview reading order: status band → KPIs → activity → anomaly → charts → provenance, no ledger or top-sessions', async ({ page }) => {
  await gotoHome(page); // default window is Today, so the Activity block is present
  await expect(page.locator('.home-dashboard .activity-card')).toBeVisible();
  // The ledger moved to /projects (D1) — it must not mount on this page at all.
  await expect(page.locator('.home-dashboard .recent-ledger')).toHaveCount(0);
  // Top-sessions-by-cost is retired from Overview (CHI-324 — absorbed by the
  // Sessions tab's cost sort); its heading must not appear.
  await expect(page.getByRole('heading', { name: /Top sessions by cost/i })).toHaveCount(0);
  const order = await page.evaluate(() => {
    const root = document.querySelector('.home-dashboard')!;
    // `.burn-card` is the anomaly tile's stable class (kept in place per D6);
    // `.sot-card` is the full-width spend-over-time chart (CHI-324 review — it
    // replaced the old `.grid2` [chart | spend-by-model] row on Overview).
    // EXTENDED for CHI-325 3d. This check is relative-order only, so the new
    // bands would have slipped past it silently while its name and this comment
    // went false: a pin that still passes but no longer describes the surface is
    // worse than no pin. `.status-band` and `.provenance-strip` are the phase-3
    // additions; the briefing band is hub-conditional so it is pinned separately
    // in home-bands.spec.ts rather than here (this server has no hub).
    const sel = ['.kpis', '.status-band', '.activity-card', '.burn-card', '.sot-card', '.provenance-strip'];
    const els = sel.map((s) => root.querySelector(s));
    if (els.some((e) => !e)) return 'missing';
    // Confirm each element strictly precedes the next in document order.
    for (let i = 0; i < els.length - 1; i++) {
      // eslint-disable-next-line no-bitwise
      const following = els[i]!.compareDocumentPosition(els[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (!following) return `out-of-order at ${sel[i]} → ${sel[i + 1]}`;
    }
    return 'ok';
  });
  expect(order).toBe('ok');
});

// ── Existing behaviors, retargeted to the merged surface ─────────────────────

test('no horizontal overflow on the hub at 1366', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await gotoHome(page);
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(ok).toBe(true);
});

test('window toggle to 7d hides the Activity block, the anomaly tile persists', async ({ page }) => {
  await gotoHome(page);
  await expect(page.locator('.activity-card')).toBeVisible();
  await page.locator('.home-dashboard .rangebar button', { hasText: /^7d$/ }).click();
  await expect(page.locator('.activity-card')).toHaveCount(0);
  // The anomaly tile (BurnTile's slot, `.burn-card`) persists on every window.
  await expect(page.locator('.burn-card')).toBeVisible();
});

test('live session shows a pulsing dot in the Activity block', async ({ page }) => {
  await gotoHome(page);
  // Open a persistent SSE stream in-page → the server registers a live watcher
  // for the fixture session, so /api/activity marks it live. The EventSource
  // lives on `window`, so it survives SPA navigation.
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

  // Remount the hub via in-app nav (keeps the EventSource open).
  await page.locator('button.sb-item[title="Projects"]').click();
  await expect(page.locator('.projects-page, .empty-state').first()).toBeVisible();
  await page.locator('button.sb-item[title="Insights"]').click();

  await expect(page.locator('.activity-row .live-dot.on').first()).toBeVisible();

  await page.evaluate(() => (window as unknown as { __es?: EventSource }).__es?.close());
});
