// E2E drift-pins for the `/?tab=spend` Spend tab (CHI-324 2b/2d/2e). Guards the
// signed surface-contract shape: budget BAND up top (no anomaly card — anomaly
// is the Overview tile only), the shared spend chart with a [project|provider]
// stack toggle, and the reading order down to the proxy lane.
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

async function gotoSpend(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/?tab=spend');
  await expect(page.locator('.home-dashboard .tabs .tab.on')).toHaveText('Spend');
  await expect(page.locator('.spend-tab')).toBeVisible();
}

test('Spend tab leads with a full-width budget BAND, not an anomaly card', async ({ page }) => {
  await gotoSpend(page);
  await expect(page.locator('.spend-tab .budget-band')).toBeVisible();
  // The anomaly lives only on the Overview tile (CHI-324 review) — no anomaly
  // card on the Spend tab.
  await expect(page.locator('.spend-tab .anom-card')).toHaveCount(0);
});

test('Spend chart stack toggle is exactly [project | provider]', async ({ page }) => {
  await gotoSpend(page);
  const opts = page.locator('.spend-tab .sot-card .stack-toggle .st-opt');
  await expect(opts).toHaveCount(2);
  await expect(opts).toHaveText(['project', 'provider']);
  // project is the default (far-left) selected option.
  await expect(page.locator('.spend-tab .sot-card .stack-toggle .st-opt.on')).toHaveText('project');
});

test('Spend tab reading order: budget → chart → efficiency (present cards stay in order)', async ({ page }) => {
  await gotoSpend(page);
  // Wait for the three always-on anchors to render (chart + efficiency fetch
  // async) before checking their order.
  await expect(page.locator('.spend-tab .budget-band')).toBeVisible();
  await expect(page.locator('.spend-tab .sot-card')).toBeVisible();
  await expect(page.locator('.spend-tab .eff-head')).toBeVisible();
  // Budget band, spend chart, and efficiency always render; skills/proxy are
  // data-conditional, so assert the order of whatever IS present (never
  // out-of-order), requiring at least the three always-on anchors.
  const order = await page.evaluate(() => {
    const root = document.querySelector('.spend-tab')!;
    const eff = [...root.querySelectorAll('.card')].find((c) => /^EFFICIENCY/i.test((c as HTMLElement).innerText));
    const present = [root.querySelector('.budget-band'), root.querySelector('.sot-card'), eff].filter(Boolean) as Element[];
    if (present.length < 3) return 'missing-anchor';
    for (let i = 0; i < present.length - 1; i++) {
      // eslint-disable-next-line no-bitwise
      if (!(present[i].compareDocumentPosition(present[i + 1]) & Node.DOCUMENT_POSITION_FOLLOWING)) return `out-of-order at ${i}`;
    }
    return 'ok';
  });
  expect(order).toBe('ok');
});
