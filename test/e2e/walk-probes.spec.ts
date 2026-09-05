// Regression pin for CHI-310: test/e2e/walk.mjs's popoverClip probe used to
// pick `.info-tip` by DOM order alone, so any route that opens an overlay
// (search modal, the session-security check modal) while an unrelated
// `.info-tip` from the underlying page stays mounted behind the backdrop
// would report a FAIL — "not hoverable right now" — even though there was
// no popover-clip defect: the tip was correctly unreachable, same as it
// would be for a real user. That's a harness coverage gap, not a UI bug, and
// it must never come back reported as a plain `fail` again (see CHI-310).
import { type Page } from '@playwright/test';
import { test, expect, readSeedState } from './helpers.ts';
import { probePopoverClip } from './walk.mjs';

const state = readSeedState();

async function openSearchModal(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/`);
  await page.locator('button.icon-btn[title^="Search"]').click();
  await page.waitForSelector('.search-modal');
}

test.describe('walk.mjs popoverClip probe', () => {
  test('reports notTestable, not fail, when every .info-tip is covered by an open modal backdrop', async ({
    page,
  }) => {
    await openSearchModal(page);

    // The search modal itself renders no InfoTip (src/SearchModal.tsx) — any
    // `.info-tip` still in the DOM belongs to the Home page underneath and is
    // legitimately covered by `.modal-backdrop` right now.
    const result = await probePopoverClip(page, 1024);

    expect(result.present).toBe(true);
    expect(result.notTestable).toBe(true);
    expect(result.pass).toBe(true);
  });

  test('still tests a reachable .info-tip normally when no overlay is open', async ({ page }) => {
    await page.goto(`${state.baseURL}/`);
    await expect(page.locator('.info-tip').first()).toBeVisible();

    const result = await probePopoverClip(page, 1024);

    expect(result.present).toBe(true);
    expect(result.notTestable).toBeFalsy();
    expect(result.pass).toBe(true);
  });
});
