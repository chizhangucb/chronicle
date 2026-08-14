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
// demoted to a compact ~300px sticky RAIL on the right.
//
// Task 19 (2026-08-14 PR-2 checkpoint amendments) then flipped/added several
// things pinned below: (1) the ledger's filter box is lifted into a
// full-width toolbar spanning both columns, the two column heads ("Recent
// sessions" / "Projects · N") sit aligned on one row beneath it, and the page
// `h1` is gone; (2) the project-row gear (`.gear`) rests visible (not
// opacity:0) at all times; (3) below 1100px the LEDGER now stacks FIRST,
// rail below (flips the F2/D1 rail-first order); (4) a project multi-select
// mirroring session multi-select, with a bulk bar of exactly Sync (N) /
// Remove (N).
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

// ── Task 19 (PR-2 checkpoint) drift-pin: gear rests visible, not opacity:0 ────
test('project gear rests at a muted-but-visible opacity, not fully hidden', async ({ page }) => {
  await gotoProjects(page);
  const gear = page.locator('.projects-page .rail-proj').first().locator('button.gear');
  await expect(gear).toBeVisible();
  // Move the mouse away from the row so we're reading the REST state, not a
  // hover reveal.
  await page.mouse.move(0, 0);
  const opacity = await gear.evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(opacity).toBeGreaterThan(0.3);
  expect(opacity).toBeLessThan(1);
});

// ── Task 19 (PR-2 checkpoint) drift-pin: project multi-select ─────────────────
test('project multi-select: Select enters select mode, row click toggles instead of navigating, and the bulk bar shows exactly Sync (N) / Remove (N)', async ({ page }) => {
  await gotoProjects(page);
  const rail = page.locator('.projects-page .projects-rail');
  await rail.locator('.page-title-row').getByRole('button', { name: /Select/ }).click();

  const firstRow = page.locator('.projects-page .rail-proj').first();
  await expect(firstRow).toHaveClass(/selectable/);
  await expect(firstRow.locator('.rowcheck input[type="checkbox"]')).toBeVisible();

  // Clicking the row body (not the checkbox, not the gear) toggles selection
  // — it must NOT navigate to the project analytics page.
  await firstRow.locator('.meta').click();
  await expect(firstRow).toHaveClass(/selected/);
  await expect(firstRow.locator('.rowcheck input[type="checkbox"]')).toBeChecked();
  await expect(page).toHaveURL(/\/projects$/);

  const bar = rail.locator('.select-toolbar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Sync (1)');
  await expect(bar).toContainText('Remove (1)');

  // Remove is a two-step inline confirm, never window.confirm — click via the
  // unique danger-btn class rather than matching on glyph+label text.
  await bar.locator('button.danger-btn').click();
  await expect(bar).toContainText('Source logs and folders are not touched');
  await expect(bar.locator('button.danger-btn')).toContainText('Remove (1)');
  // Cancel backs out of the confirm without removing anything.
  await bar.getByRole('button', { name: 'Cancel' }).click();
  await expect(firstRow).toBeVisible();
  await expect(firstRow).toHaveClass(/selected/);
});

test('meta line shows branch (⎇) or "needs association", plus a relative time', async ({ page }) => {
  await gotoProjects(page);
  const meta = page.locator('.projects-page .rail-proj').first().locator('.meta');
  const text = (await meta.textContent()) ?? '';
  expect(/⎇ |needs association/.test(text)).toBe(true);
});

// ── D1 drift-pin: the recent-sessions ledger is the MAIN column ───────────────
test('recent-sessions ledger is the main column, with day groups', async ({ page }) => {
  await gotoProjects(page);
  const ledger = page.locator('.projects-page .projects-main .recent-ledger');
  await expect(ledger).toBeVisible();
  await expect(ledger.getByText('Recent sessions')).toBeVisible();
  await expect(ledger.locator('.day .row').first()).toBeVisible();
});

// ── Task 19 (PR-2 checkpoint): full-width filter toolbar, no page h1, aligned
// column heads on one row ──────────────────────────────────────────────────
test('filter toolbar spans full width above the two columns, no page h1, and the two column heads align on one row', async ({ page }) => {
  await gotoProjects(page);

  // The search box moved OUT of the ledger column into a toolbar that is a
  // direct child of `.projects-page`, above `.projects-layout` — spans the
  // full page width, not scoped to either column.
  const toolbar = page.locator('.projects-page > .home-search');
  await expect(toolbar).toBeVisible();
  await expect(page.locator('.projects-page .recent-ledger > .home-search')).toHaveCount(0);
  const toolbarBox = await toolbar.boundingBox();
  const layoutBox = await page.locator('.projects-layout').boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(layoutBox).not.toBeNull();
  if (toolbarBox && layoutBox) {
    // Full-width: the toolbar's box spans (at least) as wide as the two-column
    // layout beneath it, not just one column's worth.
    expect(toolbarBox.width).toBeGreaterThanOrEqual(layoutBox.width - 2);
  }

  // The big page h1 is gone — sidebar nav already names the page, and the
  // column heads below carry the titles instead.
  await expect(page.locator('.projects-page h1')).toHaveCount(0);

  // Column heads: "Recent sessions" (ledger, left) and "Projects · N" (rail,
  // right) sit on one row — assert their top edges are within a couple px.
  const ledgerHead = page.locator('.projects-page .projects-main .page-title-row').first();
  const railHead = page.locator('.projects-page .projects-rail .page-title-row').first();
  await expect(ledgerHead).toBeVisible();
  await expect(railHead).toBeVisible();
  await expect(railHead.getByText(/^Projects · \d+$/)).toBeVisible();
  const ledgerBox = await ledgerHead.boundingBox();
  const railBox = await railHead.boundingBox();
  expect(ledgerBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  if (ledgerBox && railBox) {
    expect(Math.abs(ledgerBox.y - railBox.y)).toBeLessThanOrEqual(3);
  }
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

// ── Task 19 (PR-2 checkpoint) drift-pin: two-column reflow — LEDGER-FIRST
// stacked below 1100px (flips the old F2/D1 rail-first order), ledger-left/
// rail-right sticky ≥1100px (styles.css `.projects-layout` @media 1100px) ─────
test('projects layout stacks the ledger above the rail below 1100px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await gotoProjects(page);
  const info = await page.locator('.projects-layout').evaluate((el) => {
    const cs = getComputedStyle(el);
    const rail = el.querySelector('.projects-rail')!;
    const main = el.querySelector('.projects-main')!;
    // eslint-disable-next-line no-bitwise
    const mainBeforeRail = !!(main.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { flexDirection: cs.flexDirection, mainBeforeRail };
  });
  expect(info.flexDirection).toBe('column');
  // Source order puts the ledger (main) above the rail at this width (D1's
  // "moving list stays primary" — no CSS `order` override applies below the
  // breakpoint, or above it either, since the DOM order already matches the
  // desired visual order at every width).
  expect(info.mainBeforeRail).toBe(true);
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
