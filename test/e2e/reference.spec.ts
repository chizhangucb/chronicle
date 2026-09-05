// E2E for the unified reference (CHI-325 3b).
//
// The page's reason to exist is that it reads the SAME registry the ⓘ tips do,
// so the assertions below check that relationship end to end rather than just
// "the page rendered": a tip's "full definition" link must land on the entry
// whose text matches what the tip said.
//
// Everything here runs on the seeded server, which is the stock
// public-install shape.
import { test, expect } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

test.describe('/reference', () => {
  test('is reachable from the sb-bottom util group', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    const ref = page.locator('.sidebar .sb-bottom .sb-item[title="Reference"]');
    await expect(ref).toHaveCount(1);
    await ref.click();
    await expect(page.locator('.reference-page .eyebrow')).toHaveText('Reference');
    await expect(page.locator('.reference-page .ref-def').first()).toBeVisible();
  });

  test('groups definitions by surface and keeps the retired vocabulary', async ({ page }) => {
    await page.goto(state.baseURL + '/reference');
    const headings = await page.locator('.reference-page .ref-group h3').allTextContents();
    expect(headings).toContain('Insights · Overview');
    expect(headings).toContain('Insights · Spend');
    // CHI-322's "nothing valuable silently dropped": the surfaces went, the
    // words stayed.
    expect(headings).toContain('Retired (kept for the vocabulary)');
    await expect(page.locator('[data-anchor="def-retired.pinned-panels"]')).toHaveCount(1);
  });

  test('search narrows to matching definitions', async ({ page }) => {
    await page.goto(state.baseURL + '/reference');
    const all = await page.locator('.reference-page .ref-def').count();
    await page.locator('.ref-search input').fill('cache');
    const some = await page.locator('.reference-page .ref-def').count();
    expect(some).toBeGreaterThan(0);
    expect(some).toBeLessThan(all);
    await page.locator('.ref-search input').fill('zzzzz-no-such-term');
    await expect(page.locator('.reference-page .ref-def')).toHaveCount(0);
  });

  test('a tip and its reference entry say the SAME thing (the anti-drift property)', async ({ page }) => {
    await page.goto(state.baseURL + '/');
    await expect(page.locator('.home-dashboard .kpis')).toBeVisible();
    // Tips open on HOVER (src/InfoTip.tsx), not click.
    await page.locator('.kpis .info-tip').first().hover();
    const bubble = page.locator('.info-bubble').first();
    await expect(bubble).toBeVisible();
    const tipText = (await bubble.innerText()).replace(/full definition\s*→\s*$/, '').trim();
    expect(tipText.length).toBeGreaterThan(40);

    // Follow the tip's own deep link. The bubble must survive the pointer
    // moving into it, or this link is decorative.
    await page.locator('.info-bubble .info-more').first().click();
    await expect(page).toHaveURL(/\/reference#def-/);
    const entry = page.locator('.reference-page .ref-def.def-flash, .reference-page .ref-def').first();
    await expect(entry).toBeVisible();
    const entryText = (await entry.innerText()).trim();
    // The first sentence of the tip must appear verbatim in the entry. Both
    // render `plain()` from one registry, so any divergence is a regression in
    // exactly the thing this page exists to prevent.
    const firstSentence = tipText.split(/(?<=\.)\s/)[0];
    expect(entryText).toContain(firstSentence);
  });
});
