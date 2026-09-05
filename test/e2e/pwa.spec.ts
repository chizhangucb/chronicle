// PWA bridge pins.
//
// The manifest is what makes Chrome/Edge offer Install, so Chronicle gets a
// dock icon and its own window without a native shell (is the real
// one). The NO-service-worker assertion is the load-bearing half: a cached app
// shell could serve a stale UI after `npx chronicle-cli` pulled a new version,
// and there is nothing to gain offline from a server on localhost.
import { test, expect, readSeedState } from './helpers.ts';

const state = readSeedState();

test('the manifest is served and describes an installable standalone app', async ({ page }) => {
  const res = await page.request.get(state.baseURL + '/manifest.webmanifest');
  expect(res.ok()).toBeTruthy();
  const m = await res.json();
  expect(m.name).toBe('Chronicle');
  expect(m.display).toBe('standalone');
  expect(m.start_url).toBe('/');
  // Chrome's install criteria want a 192 and a 512.
  const sizes = (m.icons ?? []).map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  for (const icon of m.icons) {
    const iconRes = await page.request.get(state.baseURL + icon.src);
    expect(iconRes.ok(), `${icon.src} must actually exist`).toBeTruthy();
  }
});

test('the page links the manifest', async ({ page }) => {
  await page.goto(state.baseURL + '/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
});

test('NO service worker is registered', async ({ page }) => {
  await page.goto(state.baseURL + '/');
  await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
  const registrations = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 0;
    return (await navigator.serviceWorker.getRegistrations()).length;
  });
  // D10: a caching shell could mask a CLI upgrade. If a service worker is ever
  // added, that decision has to be made deliberately, not inherited from a
  // build plugin default.
  expect(registrations).toBe(0);
});
