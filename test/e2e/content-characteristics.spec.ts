// e2e probe for the Content tab's per-scope usage-characteristics block (D4,
// feedback-round Task 12, merging the old spec §2.5 "7 characteristics" pin
// with the new "What your usage says" merge). The unit tests
// (test/content-characteristics.test.mjs) cover the engine math on hand-built
// ground truth; this probe just confirms the block actually renders on real
// imported data — exactly 7 rows at all/project scope (each with a bold
// "N% ..." lead-in and an InfoTip trigger), and the 6-row session-facts set
// at session scope (mixed percent/tokens/hours formats, so not every row
// leads with "%").
import { test, expect, readSeedState } from './helpers.ts';

const state = readSeedState();

async function fixtureProjectId(): Promise<number> {
  const res = await fetch(`${state.baseURL}/api/sessions/${encodeURIComponent(state.sessionId)}/resolve`);
  const body = (await res.json()) as { project_id: number };
  return body.project_id;
}

function characteristicRows(page: import('@playwright/test').Page) {
  return page.locator('.card', { has: page.getByRole('heading', { name: 'What your usage says' }) }).locator('.callout');
}

test('Insights home Content tab (scope=all) renders exactly 7 usage-characteristic rows', async ({ page }) => {
  await page.goto(`${state.baseURL}/`);
  await expect(page.locator('.kpis').first()).toBeVisible();
  // The fixture is pinned to fixed early-August dates; the default Today window
  // would exclude it, so pick All (no cutoff) before opening Content.
  await page.locator('.home-dashboard .rangebar button', { hasText: /^All$/ }).click();
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

// D4: session scope replaces the 4 threshold predicates that collapse to
// 0%/100% at N=1 with absolute session facts (marathon badge, peak context
// tokens + % of window, cache hit rate, subagent/workflow token share,
// unattended ratio) — 6 rows for a real claude-code session (which has both
// duration and context-size data), every row still InfoTip-backed.
test('Session Content view renders the 6-row session-facts set, not the 7 all-scope shares', async ({ page }) => {
  // Session scope has no tab bar — Content is reached from the session
  // Overview's "See what filled the context →" link (src/session/OverviewMode.tsx).
  await page.goto(`${state.baseURL}/session/${encodeURIComponent(state.sessionId)}`);
  await page.locator('.ov-content-link').click();

  const rows = characteristicRows(page);
  await expect(rows).toHaveCount(6);
  for (let i = 0; i < 6; i++) {
    await expect(rows.nth(i).locator('button.info-tip')).toHaveCount(1);
  }
});
