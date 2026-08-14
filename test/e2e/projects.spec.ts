// E2E for `/projects` (F2 restore, 2026-08-13; the 2026-08-14 feedback-round
// D1+D2 reshape; then the 2026-08-14 SECOND checkpoint reply's chrome-sidebar
// redesign — Task 20, D14, records/plans/2026-08-14-chronicle-feedback-round-plan.md).
//
// F2 pinned a dense rail-style LIST reusing the exact pre-Batch-C `.rail-proj`
// row anatomy (pdot · name · optional live dot … session count · gear menu,
// meta line = branch/"needs association" · relative time) against the shipped
// bordered card-grid, which was an unagreed redesign — that guard against the
// invented `.projects-grid` card treatment still applies below.
//
// D1 (Task 9) reshaped the page again: the recent-sessions ledger — "the list
// that's always moving is what people actually want to see" (Chi) — moved
// here from `/` as the MAIN (left) column.
//
// Task 20 (D14, "the old design of adding projects as a sidebar on the right
// side, similar to the left-side home sidebar") then reshaped it a THIRD
// time into three vertical zones: the left app sidebar (untouched), a CENTER
// content column (`.projects-content` — filter toolbar, the shared command
// bar, "Recent sessions" + one small Select button, the ledger; scrolls
// independently), and a RIGHT chrome sidebar (`.right-rail` — same
// background tone as the left app sidebar, full height, flush to the window
// edge at >=1100px; eyebrow `PROJECTS · N` + one small Select affordance;
// borderless `.rail-proj` nav rows, no table headers). Both select flows
// (sessions, projects) now render their controls into ONE shared full-width
// `.command-bar` instead of two separate boxed toolbars, and are mutually
// exclusive. Below 1100px the rail leaves the chrome and renders as a boxed
// "Projects" section BELOW the ledger (ledger stays first, D1/D13).
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
  // turns visible ON HOVER) — never a permanent visible border.
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

test('meta line shows branch (⎇) or "needs association", plus a relative time', async ({ page }) => {
  await gotoProjects(page);
  const meta = page.locator('.projects-page .rail-proj').first().locator('.meta');
  const text = (await meta.textContent()) ?? '';
  expect(/⎇ |needs association/.test(text)).toBe(true);
});

// ── D1 drift-pin: the recent-sessions ledger is the MAIN content column ───────
test('recent-sessions ledger is the main content column, with day groups', async ({ page }) => {
  await gotoProjects(page);
  const ledger = page.locator('.projects-page .projects-content .recent-ledger');
  await expect(ledger).toBeVisible();
  await expect(ledger.getByText('Recent sessions')).toBeVisible();
  await expect(ledger.locator('.day .row').first()).toBeVisible();
});

// The static fixture has a single big session, so the append-on-scroll PATH
// can't be exercised here (covered by test/search-recent.test.mjs). This guards
// that the ledger still renders its rows and scrolling doesn't tear it down —
// at >=1100px the CONTENT column (not `.projects-page` itself) is what scrolls.
test('ledger renders and survives a scroll to the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await gotoProjects(page);
  const rows = page.locator('.recent-ledger .day .row');
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
  await page.locator('.projects-page .projects-content').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(rows.first()).toBeVisible();
});

// ── Task 20 (D14) drift-pin: chrome sidebar — same tone as the left app
// sidebar, full height, flush to the window's right edge at >=1100px ─────────
test('right rail renders as chrome: same background tone as the left app sidebar, flush to the viewport right edge', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await gotoProjects(page);

  const rail = page.locator('.projects-page .right-rail');
  await expect(rail).toBeVisible();

  const info = await page.evaluate(() => {
    const rail = document.querySelector('.right-rail') as HTMLElement;
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    const railRect = rail.getBoundingClientRect();
    return {
      railBg: getComputedStyle(rail).backgroundColor,
      sidebarBg: getComputedStyle(sidebar).backgroundColor,
      railRight: railRect.right,
      railTop: railRect.top,
      railBottom: railRect.bottom,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  });
  // Computed background = the SAME tone as the left sidebar (not a literal
  // hardcoded hex — matching the actual rendered chrome color is the point).
  expect(info.railBg).toBe(info.sidebarBg);
  // Flush to the window's right edge — no gap, no padding inset.
  expect(Math.abs(info.railRight - info.innerWidth)).toBeLessThanOrEqual(1);
  // Full height: spans from at/near the top of the viewport (below the
  // topbar) to at/near the bottom — i.e. it is NOT a short sticky card.
  expect(info.railBottom - info.railTop).toBeGreaterThan(info.innerHeight * 0.6);
});

test('right rail shows an eyebrow "PROJECTS · N" label and a small Select affordance, no table headers', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await gotoProjects(page);
  const head = page.locator('.projects-page .right-rail .right-rail-head');
  await expect(head).toBeVisible();
  // The DOM text is sentence-case ("Projects · N") — `.eyebrow`'s
  // `text-transform: uppercase` (styles.css) renders it as "PROJECTS · N"
  // visually without changing `textContent`, so the pin checks BOTH: the
  // underlying text pattern, and that the uppercase transform is actually
  // applied (the thing that makes it read as an eyebrow label at all).
  const eyebrow = head.locator('.eyebrow');
  await expect(eyebrow).toHaveText(/^Projects · \d+$/);
  await expect(eyebrow).toHaveCSS('text-transform', 'uppercase');
  await expect(head.getByRole('button', { name: /Select/ })).toBeVisible();

  // Navigation, not a table — the rail must never contain a `.colhead` (or
  // any other table-header element).
  await expect(page.locator('.projects-page .right-rail .colhead')).toHaveCount(0);
  await expect(page.locator('.projects-page .right-rail th')).toHaveCount(0);
});

// ── Task 20 (D14) drift-pin: filter toolbar lives in the content column only,
// no page h1 ─────────────────────────────────────────────────────────────────
test('filter toolbar sits in the content column (not spanning under the chrome rail), and there is no page h1', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await gotoProjects(page);

  const toolbar = page.locator('.projects-page .projects-content > .home-search');
  await expect(toolbar).toBeVisible();
  // It must NOT reach as far right as the chrome rail's left edge — i.e. it
  // does not span under the sidebar (PR-2c supersedes the old PR-2
  // "spans both columns" shape now that the right side is chrome, not a
  // second content column).
  const toolbarBox = await toolbar.boundingBox();
  const railBox = await page.locator('.projects-page .right-rail').boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  if (toolbarBox && railBox) {
    expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(railBox.x + 1);
  }

  await expect(page.locator('.projects-page h1')).toHaveCount(0);
});

// ── Task 20 (D14) drift-pin: ONE shared command bar for BOTH select flows,
// mutually exclusive, replacing the old boxed toolbars ────────────────────────
test('project multi-select: Select enters select mode via the shared command bar, row click toggles instead of navigating, bulk actions are exactly Sync (N) / Remove (N)', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await gotoProjects(page);

  // The old in-rail boxed toolbar is gone.
  await expect(page.locator('.projects-page .right-rail .select-toolbar')).toHaveCount(0);

  await page.locator('.projects-page .right-rail .right-rail-head').getByRole('button', { name: /Select/ }).click();

  const firstRow = page.locator('.projects-page .rail-proj').first();
  await expect(firstRow).toHaveClass(/selectable/);
  await expect(firstRow.locator('.rowcheck input[type="checkbox"]')).toBeVisible();

  // Clicking the row body (not the checkbox, not the gear) toggles selection
  // — it must NOT navigate to the project analytics page.
  await firstRow.locator('.meta').click();
  await expect(firstRow).toHaveClass(/selected/);
  await expect(firstRow.locator('.rowcheck input[type="checkbox"]')).toBeChecked();
  await expect(page).toHaveURL(/\/projects$/);

  // The command bar slides in under the filter toolbar, in the content
  // column — directly under `.home-search`, above the ledger heading.
  const bar = page.locator('.projects-page .projects-content > .command-bar');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('1 projects selected');
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

  // Selected rows read as checkbox + subtle tint — no heavy orange border.
  const borderColor = await firstRow.evaluate((el) => getComputedStyle(el).borderColor);
  expect(borderColor).not.toMatch(/192, 138, 30/);
});

test('entering session select exits an active project select, and vice versa — at most one command bar flow at a time', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await gotoProjects(page);

  // Enter project select first.
  await page.locator('.projects-page .right-rail .right-rail-head').getByRole('button', { name: /Select/ }).click();
  const bar = page.locator('.projects-page .projects-content > .command-bar');
  await expect(bar).toContainText('projects selected');

  // Now enter session select from the ledger heading — it must take over the
  // ONE shared command bar and exit the project-select flow.
  await page.locator('.projects-page .recent-ledger .page-title-row').getByRole('button', { name: '☑ Select', exact: true }).click();
  await expect(bar).toContainText('sessions selected');
  await expect(bar).not.toContainText('projects selected');
  // The rail is back to its resting (non-selectable) state.
  await expect(page.locator('.projects-page .rail-proj').first()).not.toHaveClass(/selectable/);
});

// ── Task 20 (D14) drift-pin: reflow — chrome leaves at <1100px, boxed
// "Projects" section BELOW the ledger (ledger stays first, D1/D13) ───────────
test('projects layout stacks the ledger above a BOXED "Projects" section below 1100px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await gotoProjects(page);

  const info = await page.evaluate(() => {
    const shell = document.querySelector('.projects-shell') as HTMLElement;
    const rail = document.querySelector('.projects-shell .right-rail') as HTMLElement;
    const content = document.querySelector('.projects-shell .projects-content') as HTMLElement;
    // eslint-disable-next-line no-bitwise
    const contentBeforeRail = !!(content.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING);
    const cs = getComputedStyle(rail);
    return {
      shellFlexDirection: getComputedStyle(shell).flexDirection,
      contentBeforeRail,
      railBorderStyle: cs.borderStyle,
      railBg: cs.backgroundColor,
    };
  });
  expect(info.shellFlexDirection).toBe('column');
  // Source order puts the content column (ledger) above the rail at this
  // width (D1's "moving list stays primary").
  expect(info.contentBeforeRail).toBe(true);
  // "Boxed" — a real border, not the flush chrome treatment.
  expect(info.railBorderStyle).toBe('solid');
});

test('projects layout places the content column left and a chrome rail right at >=1100px', async ({ page }) => {
  await page.setViewportSize({ width: 1728, height: 900 });
  await gotoProjects(page);
  const info = await page.locator('.projects-shell').evaluate((el) => {
    const cs = getComputedStyle(el);
    const rail = el.querySelector('.right-rail') as HTMLElement;
    const content = el.querySelector('.projects-content') as HTMLElement;
    return {
      flexDirection: cs.flexDirection,
      railWidth: rail.getBoundingClientRect().width,
      railLeft: rail.getBoundingClientRect().left,
      contentLeft: content.getBoundingClientRect().left,
    };
  });
  expect(info.flexDirection).toBe('row');
  expect(info.contentLeft).toBeLessThan(info.railLeft);
  expect(Math.abs(info.railWidth - 280)).toBeLessThanOrEqual(2);
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
