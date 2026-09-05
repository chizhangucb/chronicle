// Task 7 (feedback-round plan): window-matrix regression pins for the two P0s
// fixed on this branch —
//   1. sessions spanning local midnight vanished from "Today" (the OLD
//      per-engine gate compared only `started_at >= cutoff`; the fix is
//      `overlapGate` in server/windowUsage.ts, which includes a session
//      whose activity RAN INTO the window even if it started earlier).
//   2. a raw fractional-day count ("0.99…D") leaked into the Explore card
//      title instead of reading "Today".
//
// Fixture guarantee this relies on (test/e2e/harness.ts, `seedDataDir`):
// `spanningSessionId` starts 26h before seed time (always yesterday, local)
// and ends 5 minutes before seed time (always today, local); `todayOnlySessionId`
// is entirely inside the last 40 minutes. Both are non-minor (>=10 messages)
// and live in the SAME project as the big fixture, so every window below has
// guaranteed in-window data at both the home page at `/` (scope=all) and the fixture
// project's `/project/:id` (scope=project) — regardless of what real date
// this suite happens to run on.
//
// DETERMINISTIC "Today": the Today window's WIDTH is set entirely
// client-side. The rangebar sends `days = daysToday` = fractional days since
// LOCAL midnight (src/HomeDashboard.tsx / src/ProjectDetail.tsx), and the
// server computes the cutoff as `now - days*day` (server/insights.ts etc.), so
// window width == daysToday*day. Run in the first ~35 min after local midnight
// and that width collapses to minutes: the two relative fixtures (seeded 5-40
// min before seed-`now`) fall outside `[midnight, now]`, `overlapGate` drops
// both, and the Sessions KPI reads 0 (this is the flake fixes — the
// old fixture comment called it an "accepted low-probability risk"; it hit CI
// twice in a row on PR #143). Fix: freeze this file's browser clock to local
// NOON via `page.clock`, so `daysToday` is deterministically 0.5 and the Today
// window is a fixed 12h ending at ~now — always wide enough to contain the
// relative fixtures, no matter the real wall-clock time. Width depends only on
// the client, so freezing the client (not the process-wide seeded server)
// removes the wall-clock dependence with zero blast radius to other specs.
// The overlap-gate P0 stays fully exercised: `spanningSessionId` still starts
// 26h ago (before the ~12h cutoff) and ends 5 min ago (after it), so it is
// counted ONLY via overlapGate; `todayOnlySessionId` stays the naive-gate
// control. 7d/30d cases are unaffected (rangeDays ignores daysToday for them).
import { type Page } from '@playwright/test';
import { test, expect, readSeedState } from './helpers.ts';

const state = readSeedState();

// Local noon of the current day. `daysToday` = (noon - localMidnight)/day = 0.5
// exactly, independent of the real wall-clock time — the single value the whole
// determinism argument above rests on.
function localNoonMs(): number {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0).getTime();
}

// Pin the browser clock BEFORE any navigation so the `daysToday` useMemo (which
// runs `new Date()` once on mount) reads the frozen noon. `setFixedTime` only
// overrides Date/now — it does NOT fake setTimeout/setInterval/performance.now,
// so SWR revalidation, chart animations, and the `waitSettled` "no Loading…"
// signals keep working on real time.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(localNoonMs()));
});

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
// primary data view), Content (src/ContentTab.tsx) renders FOUR
// independently-scoped sub-cards (usage characteristics, tool-results-by-tool,
// skills, subagents — split into separate Skills/Subagents cards in Task 14,
// D5/D7) that each show their OWN "No sessions in range." when there's no
// data of THAT specific kind in-window — e.g. the window-matrix fixture's
// spanning/today mini sessions (test/e2e/helpers.ts) are plain
// user/assistant turns with no tool_use/subagent activity, so the
// tool-results/skills/subagents cards legitimately render empty even
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
  // Match "Sessions" at the label start, word-bounded: the Home Overview tile now
  // carries an interactive-only InfoTip so its .l text is "Sessions ⓘ",
  // while the Project-detail tile stays exactly "Sessions" — both must resolve here.
  const kpi = page.locator('.kpis .kpi').filter({ has: page.locator('.l', { hasText: /^Sessions\b/ }) }).first();
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
    `${label}: Sessions KPI must read exactly 2 (spanningSessionId + todayOnlySessionId). ` +
    `A count of 1 means the overlap-gate P0 regressed and dropped the midnight-spanning ` +
    `session (its started_at predates Today's cutoff). A count of 0 means the whole Today ` +
    `window came back empty — the browser-clock freeze at the top of this file did not take ` +
    `effect (daysToday should be a fixed 0.5), not an overlap-gate regression.`,
  ).toHaveText('2');
}

async function fixtureProjectId(): Promise<number> {
  const res = await fetch(`${state.baseURL}/api/sessions/${encodeURIComponent(state.sessionId)}/resolve`);
  const body = (await res.json()) as { project_id: number };
  return body.project_id;
}

const TABS = ['Overview', 'Explore', 'Content'] as const;

// ---- Insights home (/) — rangebar buttons are exactly Today/7d/30d/90d/All (home.spec.ts) ----
const HOME_WINDOWS = ['Today', '7d', '30d'] as const;

test.describe('window-matrix: Insights home (/) — Today/7d/30d × Overview/Explore/Content', () => {
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

// ---- Project detail (/project/:id) — rangebar buttons are Today/7d/30d/90d/All
// (unified with the home page's vocabulary via the shared RangeBar.tsx, D10, Task 17) ----

// Drift-pin: the project rangebar's option set + labels must equal the home page's
// exactly (same 5 options, same order) — this is the regression the D10
// unification (shared RangeBar.tsx) exists to prevent. Before Task 17 this
// rendered Today/7 Days/30 Days/1 Year/All time, a fully independent
// vocabulary from the home page's Today/7d/30d/90d/All.
test('the rangebar on /project/:id has exactly the same Today / 7d / 30d / 90d / All set as the home page at /', async ({ page }) => {
  const projectId = await fixtureProjectId();
  await page.goto(`${state.baseURL}/`);
  const homeOpts = page.locator('.home-dashboard .rangebar button');
  await expect(homeOpts).toHaveCount(5);
  const homeLabels = await homeOpts.allTextContents();

  await page.goto(`${state.baseURL}/project/${projectId}`);
  const projectOpts = page.locator('.project-detail .rangebar button');
  await expect(projectOpts).toHaveCount(5);
  await expect(projectOpts).toHaveText(['Today', '7d', '30d', '90d', 'All']);
  expect(await projectOpts.allTextContents()).toEqual(homeLabels);
});

const PROJECT_WINDOWS: { click: string; label: string }[] = [
  { click: 'Today', label: 'Today' },
  { click: '7d', label: '7d' },
  { click: '30d', label: '30d' },
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
