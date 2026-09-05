// InfoTip (ⓘ) P0s (Task 9, spec §2.6/§4): (a) viewport clipping — the
// popover must shift horizontally to stay inside the viewport instead of
// spilling off the right edge, while still opening DOWNWARD (never
// flipping above its trigger); (b) stuck-open — dismissing via outside
// click / Escape, or hovering several tips in quick succession, must never
// leave a `.info-bubble` element mounted after the pointer/focus has moved
// off every trigger.
//
// Surface: the Insights home KPI row (`/`) has several `.info-tip`
// triggers (Agent active / Your engaged / Tool calls / Error rate) laid out
// in a `repeat(auto-fit, minmax(132px, 1fr))` grid — at
// 1024px wide that wraps to several columns, so "right-most" is found by
// measuring bounding rects at runtime rather than assuming DOM order.
import { type Page } from '@playwright/test';
import { test, expect, readSeedState } from './helpers.ts';

const state = readSeedState();

async function gotoInsights(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/`);
  await expect(page.locator('.kpis .info-tip').first()).toBeVisible();
}

// Returns the locator for the `.info-tip` trigger whose bounding-box right
// edge is furthest right (i.e. closest to / past the viewport's right
// edge) — the one most likely to clip its popover.
async function rightmostInfoTip(page: Page) {
  const tips = page.locator('.info-tip');
  const count = await tips.count();
  expect(count, 'expected at least one .info-tip on the Insights page').toBeGreaterThan(0);
  let bestIndex = 0;
  let bestRight = -Infinity;
  for (let i = 0; i < count; i++) {
    const box = await tips.nth(i).boundingBox();
    if (box && box.x + box.width > bestRight) {
      bestRight = box.x + box.width;
      bestIndex = i;
    }
  }
  return tips.nth(bestIndex);
}

test.describe('InfoTip viewport clipping', () => {
  test('right-most KPI tip at 1024px stays inside the viewport and opens downward', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await gotoInsights(page);

    const trigger = await rightmostInfoTip(page);
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();

    await trigger.hover();
    const bubble = page.locator('.info-bubble');
    await expect(bubble).toBeVisible();
    const bubbleBox = await bubble.boundingBox();
    expect(bubbleBox).not.toBeNull();

    // Fully inside the viewport horizontally (never clipped off either edge).
    expect(bubbleBox!.x, 'bubble left edge clipped off the viewport').toBeGreaterThanOrEqual(0);
    expect(
      bubbleBox!.x + bubbleBox!.width,
      `bubble right edge (${bubbleBox!.x + bubbleBox!.width}) exceeds viewport width (1024)`
    ).toBeLessThanOrEqual(1024);

    // Still opens DOWNWARD: the bubble's top must be at/below the trigger's
    // bottom, never flipped above it.
    expect(
      bubbleBox!.y,
      'bubble opened above its trigger (flipped upward)'
    ).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height - 1);
  });
});

test.describe('InfoTip stuck-open', () => {
  test('outside click closes the bubble', async ({ page }) => {
    await gotoInsights(page);
    const trigger = page.locator('.info-tip').first();
    await trigger.hover();
    await expect(page.locator('.info-bubble')).toBeVisible();

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.info-bubble')).toHaveCount(0);
  });

  test('Escape closes the bubble', async ({ page }) => {
    await gotoInsights(page);
    const trigger = page.locator('.info-tip').first();
    await trigger.hover();
    await expect(page.locator('.info-bubble')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.info-bubble')).toHaveCount(0);
  });

  test('hovering several tips rapidly leaves zero stray bubbles once the pointer moves away', async ({ page }) => {
    await gotoInsights(page);
    const tips = page.locator('.info-tip');
    const count = Math.min(5, await tips.count());
    expect(count, 'need at least a few .info-tip triggers for this probe').toBeGreaterThan(1);

    for (let i = 0; i < count; i++) {
      await tips.nth(i).hover({ force: true, timeout: 2000 });
    }
    // Move the pointer off every trigger onto neutral chrome.
    await page.locator('.dash-head').first().hover();
    await expect(page.locator('.info-bubble')).toHaveCount(0);
  });
});
