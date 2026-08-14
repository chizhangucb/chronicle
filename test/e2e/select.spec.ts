// Task 14 E2E: bulk-select upgrades on the recent-sessions ledger (spec §2.2).
//
// 2026-08-14 feedback round (D1, records/plans/2026-08-14-chronicle-feedback-
// round-plan.md): the ledger moved from `/` to `/projects` (main column,
// beside the projects rail) — see projects.spec.ts. The ledger component
// (`RecentLedger`) and its selectors are unchanged; only the route it's
// mounted under moved, so this suite is retargeted below.
//
// The Task-1 big fixture is deliberately ONE session on ONE day, which can't
// exercise day-group tri-state selection or a filtered multi-row "Select
// all" — helpers.ts additionally seeds 3 small mini-fixture sessions
// (test/fixtures/gen-mini-session.mjs): Alpha + Bravo share a second day (2
// visible rows in one day-group), and a third, sub-10-message session that
// the noise gate (server/noiseGate.ts) routes into the global minor-sessions
// bucket instead of the main ledger.
//
// Dialog invariant: window.confirm/alert/prompt are banned app-wide (blocked
// in embedded browsers; test/no-window-dialogs.test.mjs guards the source).
// Every test here registers a `page.on('dialog', …)` handler that fails loudly
// if a native dialog ever fires, so the Remove flow's inline confirm bar is
// verified, not just assumed.
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

async function gotoProjects(page: Page): Promise<void> {
  page.on('dialog', (d) => { throw new Error(`Unexpected native dialog: ${d.type()} ${d.message()}`); });
  await page.goto(state.baseURL + '/projects');
  await expect(page.locator('.recent-ledger .day .row').first()).toBeVisible();
}

function rowByTitle(page: Page, title: string) {
  return page.locator('.recent-ledger .row').filter({ has: page.locator('.title .t', { hasText: title }) });
}

async function enterSelectMode(page: Page): Promise<void> {
  await page.getByRole('button', { name: '☑ Select', exact: true }).click();
  await expect(page.locator('.recent-ledger .select-toolbar')).toBeVisible();
}

test.describe('bulk select — recent-sessions ledger (/projects)', () => {
  test('day-group header checkbox selects exactly that day\'s visible rows, tri-state via indeterminate', async ({ page }) => {
    await gotoProjects(page);
    await enterSelectMode(page);

    const alphaRow = rowByTitle(page, 'Mini fixture Alpha');
    const bravoRow = rowByTitle(page, 'Mini fixture Bravo');
    await expect(alphaRow).toBeVisible();
    await expect(bravoRow).toBeVisible();

    const day = page.locator('.recent-ledger .day').filter({ has: page.locator('.title .t', { hasText: 'Mini fixture Alpha' }) });
    await expect(day.locator('.row')).toHaveCount(2); // Alpha + Bravo share a day
    await expect(day.locator('.title .t', { hasText: 'Mini fixture Bravo' })).toBeVisible();

    const dayCheckbox = day.locator('.day-head .daycheck input[type="checkbox"]');
    const alphaCheckbox = alphaRow.locator('.rowcheck input[type="checkbox"]');
    const bravoCheckbox = bravoRow.locator('.rowcheck input[type="checkbox"]');
    await expect(dayCheckbox).toBeVisible();

    await expect(dayCheckbox).not.toBeChecked();
    expect(await dayCheckbox.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(false);

    // Partial selection (one of the two rows) -> indeterminate, not checked.
    await alphaCheckbox.check();
    await expect(dayCheckbox).not.toBeChecked();
    await expect.poll(() => dayCheckbox.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);

    // A day-group elsewhere in the ledger is untouched by this partial pick.
    const otherRow = page.locator('.recent-ledger .row').filter({ hasNot: page.locator('.title .t', { hasText: /Mini fixture/ }) }).first();
    await expect(otherRow).toBeVisible();
    await expect(otherRow.locator('.rowcheck input[type="checkbox"]')).not.toBeChecked();

    // Checking the (indeterminate) day header selects the REST of that day, exactly.
    await dayCheckbox.check();
    await expect(alphaCheckbox).toBeChecked();
    await expect(bravoCheckbox).toBeChecked();
    expect(await dayCheckbox.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(false);
    await expect(otherRow.locator('.rowcheck input[type="checkbox"]')).not.toBeChecked();

    // Unchecking the day header clears exactly that day.
    await dayCheckbox.uncheck();
    await expect(alphaCheckbox).not.toBeChecked();
    await expect(bravoCheckbox).not.toBeChecked();
  });

  test('checkbox hit targets (day header + per-row) are at least 24x24px', async ({ page }) => {
    await gotoProjects(page);
    await enterSelectMode(page);
    const day = page.locator('.recent-ledger .day').filter({ has: page.locator('.title .t', { hasText: 'Mini fixture Alpha' }) });
    const targets = [day.locator('.day-head .daycheck'), rowByTitle(page, 'Mini fixture Alpha').locator('.rowcheck')];
    for (const target of targets) {
      const box = await target.boundingBox();
      expect(box, 'checkbox target must be visible/have a bounding box').not.toBeNull();
      expect(box!.width, 'checkbox hit target width').toBeGreaterThanOrEqual(24);
      expect(box!.height, 'checkbox hit target height').toBeGreaterThanOrEqual(24);
    }
  });

  test('filter narrows rows, then "Select all" selects only the filtered rows', async ({ page }) => {
    await gotoProjects(page);
    await page.getByPlaceholder(/Filter sessions/).fill('Bravo');
    await expect(page.locator('.recent-ledger .row')).toHaveCount(1);
    await expect(rowByTitle(page, 'Mini fixture Bravo')).toBeVisible();

    await enterSelectMode(page);
    await page.getByRole('button', { name: /^Select all$/ }).click();
    await expect(page.locator('.select-toolbar .muted.small', { hasText: '1 selected' })).toBeVisible();
    await expect(rowByTitle(page, 'Mini fixture Bravo').locator('.rowcheck input[type="checkbox"]')).toBeChecked();
  });

  test('"Select minor sessions" quick-select appears when the minor bucket is non-empty', async ({ page }) => {
    await gotoProjects(page);
    const quickSelect = page.locator('.recent-ledger .minor-quick-select');
    await expect(quickSelect).toBeVisible();
    await expect(quickSelect).toContainText('1'); // exactly the one seeded minor session

    await quickSelect.click();
    await expect(page.locator('.recent-ledger .select-toolbar')).toBeVisible();
    await expect(page.locator('.select-toolbar .muted.small', { hasText: '1 selected' })).toBeVisible();
  });

  test('quick-select minor sessions composes with "Select all" (union, not replace)', async ({ page }) => {
    await gotoProjects(page);
    // Unfiltered: big fixture + Alpha + Bravo are all visible in the ledger.
    const totalRows = await page.locator('.recent-ledger .row').count();
    expect(totalRows).toBeGreaterThanOrEqual(3);

    await page.locator('.recent-ledger .minor-quick-select').click();
    await expect(page.locator('.select-toolbar .muted.small', { hasText: '1 selected' })).toBeVisible();

    // "Select all" must UNION the visible ids into the selection, not replace
    // it — a naive `setSelected(new Set(visibleIds))` would silently drop the
    // minor id here (the regression this test guards against).
    await page.getByRole('button', { name: /^Select all$/ }).click();
    await expect(page.locator('.select-toolbar .muted.small', { hasText: `${totalRows + 1} selected` })).toBeVisible();
    const checkboxes = page.locator('.recent-ledger .rowcheck input[type="checkbox"]');
    expect(await checkboxes.count()).toBe(totalRows);
    for (let i = 0; i < totalRows; i++) await expect(checkboxes.nth(i)).toBeChecked();
    // The button itself must key off "are all VISIBLE ids selected", not a
    // raw Set-size comparison (which the extra minor id would always fail).
    await expect(page.getByRole('button', { name: /^Clear$/ })).toBeVisible();

    // Clear SUBTRACTS only the visible ids — the invisible minor id survives.
    await page.getByRole('button', { name: /^Clear$/ }).click();
    await expect(page.locator('.select-toolbar .muted.small', { hasText: '1 selected' })).toBeVisible();
    for (let i = 0; i < totalRows; i++) await expect(checkboxes.nth(i)).not.toBeChecked();
  });

  // Destructive — runs LAST so earlier tests can still rely on Alpha existing.
  test('Remove uses the inline confirm bar (never a native dialog) and completes', async ({ page }) => {
    await gotoProjects(page);
    await enterSelectMode(page);
    await rowByTitle(page, 'Mini fixture Alpha').locator('.rowcheck input[type="checkbox"]').check();

    await page.getByRole('button', { name: /⌫ Remove/ }).click();
    // Inline confirm bar (never window.confirm — the page.on('dialog') handler
    // registered in gotoProjects would throw if a native dialog fired instead).
    await expect(page.locator('.select-toolbar', { hasText: 'Remove these sessions from Chronicle' })).toBeVisible();
    await page.getByRole('button', { name: '⌫ Remove 1', exact: true }).click();

    await expect(rowByTitle(page, 'Mini fixture Alpha')).toHaveCount(0);
  });
});
