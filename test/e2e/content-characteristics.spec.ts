// Minimal e2e probe for the Content tab's 7 usage characteristics block
// (task C3-T15, spec §2.5). The unit tests (test/content-characteristics.test.mjs)
// cover the engine math on hand-built ground truth; this probe just confirms
// the block actually renders on a real imported session's Content tab —
// exactly 7 rows, each with a bold "N% ..." lead-in and an InfoTip trigger —
// at both the Insights-hub (scope=all) and per-project Content tabs.
import { test, expect } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

async function fixtureProjectId(): Promise<number> {
  const res = await fetch(`${state.baseURL}/api/sessions/${encodeURIComponent(state.sessionId)}/resolve`);
  const body = (await res.json()) as { project_id: number };
  return body.project_id;
}

function characteristicRows(page: import('@playwright/test').Page) {
  return page.locator('.card', { has: page.getByRole('heading', { name: 'Usage characteristics' }) }).locator('.callout');
}

test('Insights Content tab (scope=all) renders exactly 7 usage-characteristic rows', async ({ page }) => {
  await page.goto(`${state.baseURL}/insights`);
  await expect(page.locator('.kpis').first()).toBeVisible();
  await page.locator('.tabs .tab', { hasText: 'Content' }).click();

  const rows = characteristicRows(page);
  await expect(rows).toHaveCount(7);

  // Every row leads with a bold "N% ..." line and carries an InfoTip trigger.
  for (let i = 0; i < 7; i++) {
    const row = rows.nth(i);
    await expect(row.locator('b')).toContainText('%');
    await expect(row.locator('button.info-tip')).toHaveCount(1);
  }
});

test('Project Content tab renders exactly 7 usage-characteristic rows', async ({ page }) => {
  const projectId = await fixtureProjectId();
  await page.goto(`${state.baseURL}/project/${projectId}/content`);
  const rows = characteristicRows(page);
  await expect(rows).toHaveCount(7);
});
