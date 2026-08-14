// Task 7 (feedback-round plan): window-matrix regression pins for the two P0s
// fixed on this branch —
//   1. sessions spanning local midnight vanished from "Today" (the OLD
//      per-engine gate compared only `started_at >= cutoff`; the fix is
//      `overlapGate` in server/windowUsage.ts, which includes a session
//      whose activity RAN INTO the window even if it started earlier).
//   2. a raw fractional-day count ("0.99…D") leaked into the Explore card
//      title instead of reading "Today".
//
// Fixture guarantee this relies on (test/e2e/helpers.ts `launchSeeded`):
// `spanningSessionId` starts 26h before seed time (always yesterday, local)
// and ends 5 minutes before seed time (always today, local); `todayOnlySessionId`
// is entirely inside the last 40 minutes. Both are non-minor (>=10 messages)
// and live in the SAME project as the big fixture, so every window below has
// guaranteed in-window data at both the `/` hub (scope=all) and the fixture
// project's `/project/:id` (scope=project) — regardless of what real date
// this suite happens to run on.
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

const NO_DATA_STRINGS = ['No sessions in range.', 'No activity in this time range.'];

// Every wait below is on a visible/absent DOM condition, never a sleep: the
// "no Loading… left anywhere on the page" check is a single generic settle
// signal that works whether the window/tab click actually triggered a new
// fetch (useCachedFetch's stale-while-revalidate can also render cached data
// immediately with nothing to wait for) or not.
async function waitSettled(page: Page): Promise<void> {
  await expect(page.locator('text=Loading…')).toHaveCount(0);
}

async function assertNonEmpty(page: Page, label: string): Promise<void> {
  for (const needle of NO_DATA_STRINGS) {
    await expect(page.locator('body'), `${label}: found "${needle}" — fixture data should always be in-window`)
      .not.toContainText(needle);
  }
}

// Content-tab counterpart to assertNonEmpty: unlike Overview/Explore (one
// primary data view), Content (src/ContentTab.tsx) renders THREE
// independently-scoped sub-cards (usage characteristics, tool-results-by-tool,
// skills & subagents) that each show their OWN "No sessions in range." when
// there's no data of THAT specific kind in-window — e.g. the window-matrix
// fixture's spanning/today mini sessions (test/e2e/helpers.ts) are plain
// user/assistant turns with no tool_use/subagent activity, so the
// tool-results and skills&subagents cards legitimately render empty even
// though the tab as a whole has real in-window session data. So instead of
// asserting NO "No sessions in range." text anywhere on the page (too
// strict — flags real, correct empty states), assert the one signal that's
// always non-zero whenever ANY session lands in-window: the composition
// footer's own calibrated token total (`t('Calibrated tokens {range}: …')`
// in ContentTab.tsx), which sums every message's text length across every
// session in scope regardless of whether any of them called a tool.
async function assertContentNonEmpty(page: Page, label: string): Promise<void> {
  const footer = page.getByText(/Calibrated tokens/).first();
  await expect(footer, `${label}: no composition footer rendered`).toBeVisible();
  const text = (await footer.textContent()) ?? '';
  expect(text, `${label}: composition footer shows a zero token total: "${text}"`).toMatch(/Calibrated tokens.*: [1-9][\d,]*/);
}

// Float-day-leak pin (item 2 above): a card title / composition footer must
// never show a raw fractional day count instead of "Today". Checks BOTH the
// Explore card's h3 (src/ExploreTab.tsx `rangeLabel`) and the Content
// composition footer (src/ContentTab.tsx `rangeLabel`, same bug class, fixed
// alongside the probe that caught it — see task-7-report.md).
async function assertNoFloatDayLeak(page: Page, label: string): Promise<void> {
  const heading = page.locator('.card h3').first();
  await expect(heading, `${label}: no Explore card heading rendered`).toBeVisible();
  const text = (await heading.textContent()) ?? '';
  expect(text, `${label}: Explore card title leaked a raw float day count: "${text}"`).not.toMatch(/\d\.\d+d/i);
}

async function assertContentNoFloatDayLeak(page: Page, label: string): Promise<void> {
  const footer = page.getByText(/Calibrated tokens/).first();
  await expect(footer, `${label}: no composition footer rendered`).toBeVisible();
  const text = (await footer.textContent()) ?? '';
  expect(text, `${label}: composition footer leaked a raw float day count: "${text}"`).not.toMatch(/\d\.\d+d/i);
}

// Isolation pin for the overlapGate P0 (item 1 in the header comment): the
// page-wide "renders non-empty" checks above pass even under the OLD
// `started_at >= cutoff` gate, because `todayOnlySessionId` (entirely inside
// the last 40 minutes) satisfies even the naive gate on its own — they never
// actually exercise the fix. Only `spanningSessionId` (started 26h ago,
// ended 5 minutes ago) requires the overlap fix to be counted, since its
// `started_at` predates "Today"'s cutoff. So isolate its presence with an
// exact count, not just "some data exists": the Sessions KPI
// (`kpis.sessionCount = result.sessions.length` in src/HomeDashboard.tsx,
// `sessions.length` in src/ProjectDetail.tsx — both driven by a server query
// gated with `overlapGate`, see server/insights.ts / server/routes/projects.ts)
// must read exactly 2 for "Today" — spanningSessionId + todayOnlySessionId.
// A regression back to the naive gate drops spanningSessionId and the count
// reads 1. Every OTHER fixture session (the big fixture + the 3 Task-14 mini
// sessions) is pinned to a fixed 2026-08 calendar date, so none of them ever
// overlap "Today" regardless of what real date this suite runs on.
async function assertTodaySessionCountIsTwo(page: Page, label: string): Promise<void> {
  const kpi = page.locator('.kpis .kpi').filter({ has: page.locator('.l', { hasText: /^Sessions$/ }) }).first();
  await expect(kpi, `${label}: no Sessions KPI tile rendered`).toBeVisible();
  // Auto-retrying assertion, not a one-shot `.textContent()` read: ProjectDetail.tsx
  // defaults `range` to 'all' (unlike Home, which defaults straight to 'today'), so
  // clicking "Today" is a REAL all→today transition — useCachedFetch's
  // stale-while-revalidate (src/useCachedFetch.ts) keeps rendering the previous
  // (all-time, unwindowed) KPI value while the new windowed fetch is in flight, and
  // `waitSettled` above (no "Loading…" text) doesn't catch that transition (documented
  // in its own comment: SWR can render cached data immediately with nothing to wait
  // on). A one-shot read raced ahead and caught the stale all-time count (4 — every
  // non-minor session in the fixture project, not just today's) instead of the fresh
  // windowed one; `toHaveText` polls until the DOM settles on the real value.
  await expect(
    kpi.locator('.v'),
    `${label}: Sessions KPI must read exactly 2 (spanningSessionId + todayOnlySessionId) — ` +
    `a count of 1 means the overlap-gate P0 regressed and dropped the midnight-spanning session`,
  ).toHaveText('2');
}

async function fixtureProjectId(): Promise<number> {
  const res = await fetch(`${state.baseURL}/api/sessions/${encodeURIComponent(state.sessionId)}/resolve`);
  const body = (await res.json()) as { project_id: number };
  return body.project_id;
}

const TABS = ['Overview', 'Explore', 'Content'] as const;

// ---- Home hub (/) — rangebar buttons are exactly Today/7d/30d/90d/All (home.spec.ts) ----
const HOME_WINDOWS = ['Today', '7d', '30d'] as const;

test.describe('window-matrix: Home hub (/) — Today/7d/30d × Overview/Explore/Content', () => {
  for (const win of HOME_WINDOWS) {
    for (const tabName of TABS) {
      test(`${win} × ${tabName}: renders non-empty${tabName === 'Explore' || tabName === 'Content' ? ', no float-day leak' : ''}`, async ({ page }) => {
        await page.goto(`${state.baseURL}/`);
        await expect(page.locator('.home-dashboard .kpis')).toBeVisible();

        await page.locator('.home-dashboard .rangebar button', { hasText: new RegExp(`^${win}$`) }).click();
        await waitSettled(page);
        await page.locator('.home-dashboard .tabs .tab', { hasText: new RegExp(`^${tabName}$`) }).click();
        await waitSettled(page);

        const label = `Home ${win} × ${tabName}`;
        if (tabName === 'Explore') await assertNoFloatDayLeak(page, label);
        if (tabName === 'Content') {
          await assertContentNoFloatDayLeak(page, label);
          await assertContentNonEmpty(page, label);
        } else {
          await assertNonEmpty(page, label);
        }
        // Overview is where the Sessions KPI renders (Explore/Content hide
        // .kpis) — see the overlapGate isolation comment above.
        if (win === 'Today' && tabName === 'Overview') await assertTodaySessionCountIsTwo(page, label);
      });
    }
  }
});

// ---- Project detail (/project/:id) — rangebar buttons are Today/7 Days/30 Days/1 Year/All time (ProjectDetail RANGES) ----
const PROJECT_WINDOWS: { click: string; label: string }[] = [
  { click: 'Today', label: 'Today' },
  { click: '7 Days', label: '7d' },
  { click: '30 Days', label: '30d' },
];

test.describe('window-matrix: project detail (/project/:id) — Today/7d/30d × Overview/Explore/Content', () => {
  for (const win of PROJECT_WINDOWS) {
    for (const tabName of TABS) {
      test(`${win.label} × ${tabName}: renders non-empty${tabName === 'Explore' || tabName === 'Content' ? ', no float-day leak' : ''}`, async ({ page }) => {
        const projectId = await fixtureProjectId();
        await page.goto(`${state.baseURL}/project/${projectId}`);
        await expect(page.locator('.project-detail .kpis').first()).toBeVisible();

        await page.locator('.project-detail .rangebar button', { hasText: new RegExp(`^${win.click}$`) }).click();
        await waitSettled(page);
        await page.locator('.project-detail .tabs .tab', { hasText: new RegExp(`^${tabName}$`) }).click();
        await waitSettled(page);

        const label = `Project ${win.label} × ${tabName}`;
        if (tabName === 'Explore') await assertNoFloatDayLeak(page, label);
        if (tabName === 'Content') {
          await assertContentNoFloatDayLeak(page, label);
          await assertContentNonEmpty(page, label);
        } else {
          await assertNonEmpty(page, label);
        }
        if (win.label === 'Today' && tabName === 'Overview') await assertTodaySessionCountIsTwo(page, label);
      });
    }
  }
});
