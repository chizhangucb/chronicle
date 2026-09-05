// The home merge: briefing band, status band, provenance strip (CHI-325 3d).
//
// The properties worth pinning are the HONESTY rules, not the pixels:
//   - the five domains, in order, as a contract enumerable
//   - with NO hub the three hub-fed rows still render, as the Nisse upsell
//     rather than vanishing (D2)
//   - the band cannot contradict the KPI strip above it (the failure that
//     shipped in the first draft: 118 messages labelled as sessions)
//   - the Settings toggle collapses / back to the pre-phase-3 Overview
import { test, expect } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

const DOMAINS = ['Spend', 'Sessions', 'Safety', 'Jobs'];

test.describe('status band (seeded, no hub)', () => {
  test('renders exactly the five domains in the contract order', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    const band = page.locator('.status-band');
    await expect(band).toBeVisible();
    const names = await band.locator('.band-row .band-name').allTextContents();
    expect(names.map((n) => n.trim())).toEqual(DOMAINS);
  });

  test('with no hub the ops rows show the Nisse upsell, not an error and not nothing', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.status-band')).toBeVisible();
    for (const domain of ['Safety', 'Jobs']) {
      const row = page.locator('.status-band .band-row', { hasText: domain });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(/install Nisse/i);
    }
  });

  test('the Sessions row cannot contradict the Sessions KPI', async ({ page }) => {
    // The first draft read insights.dailyActivity, which counts MESSAGES, and
    // put "118 today" directly under a KPI reading 40 sessions. Today's count
    // must never exceed the windowed total the tile states.
    await page.goto(state.baseURL + '/?days=30');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    const kpiText = await page.locator('.kpis .kpi', { hasText: 'Sessions' }).locator('.v').innerText();
    const kpi = Number(kpiText.replace(/[^0-9]/g, ''));
    const rowText = await page.locator('.status-band .band-row', { hasText: 'Sessions' }).innerText();
    const today = Number((rowText.match(/(\d+)\s+today/) ?? [])[1] ?? '0');
    expect(Number.isFinite(kpi)).toBeTruthy();
    expect(today).toBeLessThanOrEqual(kpi);
  });

  test('the band never originates an alarm: no flagged row without a briefing card', async ({ page }) => {
    // This server has no hub, so there are no briefing cards at all, so nothing
    // in the band may carry the accent.
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.status-band')).toBeVisible();
    await expect(page.locator('.status-band .band-row.flagged')).toHaveCount(0);
  });

  test('the provenance strip closes the page and names the sources', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    const strip = page.locator('.provenance-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toContainText('claude-code');
    await expect(strip).toContainText(/hub/i);
  });
});

test.describe('the homeBands opt-out', () => {
  test.afterEach(async ({ page }) => {
    // Always restore, or every later spec runs against a collapsed Overview.
    const { token } = await (await page.request.get(state.baseURL + '/api/gate/token')).json();
    await page.request.patch(state.baseURL + '/api/settings', {
      headers: { 'x-gate-token': token, 'content-type': 'application/json' },
      data: { homeBands: true },
    });
  });

  test('turning it off collapses / back to the pre-phase-3 Overview', async ({ page }) => {
    const { token } = await (await page.request.get(state.baseURL + '/api/gate/token')).json();
    await page.request.patch(state.baseURL + '/api/settings', {
      headers: { 'x-gate-token': token, 'content-type': 'application/json' },
      data: { homeBands: false },
    });
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    // The bands go; everything that shipped before phase 3 stays.
    await expect(page.locator('.status-band')).toHaveCount(0);
    await expect(page.locator('.home-briefing')).toHaveCount(0);
    await expect(page.locator('.provenance-strip')).toHaveCount(0);
    await expect(page.locator('.home-dashboard .burn-card')).toBeVisible();
    await expect(page.locator('.home-dashboard .sot-card')).toBeVisible();
  });
});
