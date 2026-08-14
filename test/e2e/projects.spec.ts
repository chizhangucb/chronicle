// E2E for `/projects` (F2 restore, 2026-08-13, plus the 2026-08-14 feedback-round
// reshape, D1+D2 — records/plans/2026-08-14-chronicle-feedback-round-plan.md).
//
// F2 pinned a dense rail-style LIST reusing the exact pre-Batch-C `.rail-proj`
// row anatomy (pdot · name · optional live dot … session count · gear menu,
// meta line = branch/"needs association" · relative time) against the shipped
// bordered card-grid, which was an unagreed redesign — that guard against the
// invented `.projects-grid` card treatment still applies below.
//
// D1 (Task 9) then reshaped the page again: the recent-sessions ledger — "the
// list that's always moving is what people actually want to see" (Chi) — moved
// here from `/` as the MAIN (left) column, with the `.rail-proj` project list
// demoted to a compact ~300px sticky RAIL on the right. Below ~1100px the rail
// stacks ABOVE the ledger (source order; it's short).
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

// ── D1 drift-pin: the recent-sessions ledger is the MAIN column ───────────────
test('recent-sessions ledger is the main column, with search + day groups', async ({ page }) => {
  await gotoProjects(page);
  const ledger = page.locator('.projects-page .projects-main .recent-ledger');
  await expect(ledger).toBeVisible();
  await expect(ledger.locator('.home-search')).toBeVisible();
  await expect(ledger.getByText('Recent sessions')).toBeVisible();
  await expect(ledger.locator('.day .row').first()).toBeVisible();
});

// The static fixture has a single big session, so the append-on-scroll PATH
// can't be exercised here (covered by test/search-recent.test.mjs). This guards
// that the ledger still renders its rows and scrolling doesn't tear it down.
// (Moved from home.spec.ts, D1 — the ledger no longer lives on `/`.)
test('ledger renders and survives a scroll to the bottom', async ({ page }) => {
  await gotoProjects(page);
  const rows = page.locator('.recent-ledger .day .row');
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
  await page.locator('.projects-page').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(rows.first()).toBeVisible();
});

// ── D1 drift-pin: two-column reflow — stacked below 1100px, ledger-left/
// rail-right sticky ≥1100px (styles.css `.projects-layout` @media 1100px) ─────
test('projects layout stacks the rail above the ledger below 1100px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await gotoProjects(page);
  const info = await page.locator('.projects-layout').evaluate((el) => {
    const cs = getComputedStyle(el);
    const rail = el.querySelector('.projects-rail')!;
    const main = el.querySelector('.projects-main')!;
    // eslint-disable-next-line no-bitwise
    const railBeforeMain = !!(rail.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { flexDirection: cs.flexDirection, railBeforeMain };
  });
  expect(info.flexDirection).toBe('column');
  // Source order puts the rail above the ledger at this width (no CSS `order`
  // override applies below the breakpoint).
  expect(info.railBeforeMain).toBe(true);
});

test('projects layout places the ledger main column left and a ~300px sticky rail right at >=1100px', async ({ page }) => {
  await page.setViewportSize({ width: 1728, height: 900 });
  await gotoProjects(page);
  const info = await page.locator('.projects-layout').evaluate((el) => {
    const cs = getComputedStyle(el);
    const rail = el.querySelector('.projects-rail') as HTMLElement;
    const main = el.querySelector('.projects-main') as HTMLElement;
    return {
      flexDirection: cs.flexDirection,
      railWidth: rail.getBoundingClientRect().width,
      railLeft: rail.getBoundingClientRect().left,
      mainLeft: main.getBoundingClientRect().left,
      railPosition: getComputedStyle(rail).position,
    };
  });
  expect(info.flexDirection).toBe('row');
  // The ledger (main) sits visually LEFT of the rail once the row layout
  // kicks in — this is the D1 shape (`order: 1` main / `order: 2` rail).
  expect(info.mainLeft).toBeLessThan(info.railLeft);
  expect(Math.abs(info.railWidth - 300)).toBeLessThanOrEqual(2);
  expect(info.railPosition).toBe('sticky');
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
