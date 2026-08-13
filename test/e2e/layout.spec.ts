// C2 Task 12 layout probes (spec `.superpowers/sdd/2026-08-12-chronicle-quality-pass-plan/
// task-12-brief.md`): RED-first probes for the five Chi-reported layout defects, plus a
// document-wide overflow sweep across every route/mode Batch C's fixture can reach (probe
// (e)). Each probe is written to FAIL on the pre-fix markup/CSS and PASS once the Task-11
// policy classes (`.num-col`/`.ts-col`/`.pane`/`--gap-N`) are applied — see task-12-report.md
// for the per-probe RED/GREEN table recorded during development.
import { test, expect, type Page } from '@playwright/test';
import { readSeedState, WIDTHS } from './helpers.ts';

const state = readSeedState();

async function gotoHome(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/');
  await expect(page.locator('.day .row').first()).toBeVisible();
}

async function gotoFixtureOverview(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/session/${encodeURIComponent(state.sessionId)}`);
  await expect(page.getByRole('heading', { name: /Files touched/ })).toBeVisible();
}

async function gotoFixtureRefine(page: Page): Promise<void> {
  await gotoFixtureOverview(page);
  await page.locator('button[title^="Refine"]').click();
  await expect(page.locator('.refine')).toBeVisible();
}

async function gotoInsights(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/insights`);
  await expect(page.locator('.kpis').first()).toBeVisible();
}

async function fixtureProjectId(): Promise<number> {
  const res = await fetch(`${state.baseURL}/api/sessions/${encodeURIComponent(state.sessionId)}/resolve`);
  const body = (await res.json()) as { project_id: number };
  return body.project_id;
}

async function gapVarPx(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (n) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n)),
    name,
  );
}

// ── (a) Home ledger: Cost/Active/Msgs/When alignment + header/body column
// registration + When overflow ──────────────────────────────────────────────

test.describe('(a) Home ledger column policy', () => {
  test('Cost/Active/Msgs cells use .num-col and are right-aligned tabular numerics', async ({ page }) => {
    await gotoHome(page);
    const bad = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.day .row')].slice(0, 20);
      const problems: string[] = [];
      for (const row of rows) {
        const metricCells = [...row.querySelectorAll(':scope > .m')].slice(1, 4); // cost, active, msgs
        for (const cell of metricCells) {
          // Class-presence check (not just computed style) — a regression
          // guard that fails if a future edit reverts to a per-surface
          // one-off that happens to produce the same visual result today.
          if (!cell.classList.contains('num-col')) problems.push(`missing .num-col class: "${cell.textContent}"`);
          const cs = getComputedStyle(cell);
          if (!cs.fontVariantNumeric.includes('tabular')) {
            problems.push(`not tabular: "${cell.textContent}" (fontVariantNumeric=${cs.fontVariantNumeric})`);
          }
          if (cs.textAlign !== 'right') {
            problems.push(`not right-aligned: "${cell.textContent}" (textAlign=${cs.textAlign})`);
          }
        }
      }
      return problems;
    });
    expect(bad, bad.join('; ')).toEqual([]);
  });

  test('When cell is right-aligned tabular numerics, uses .ts-col, and never overflows its cell', async ({ page }) => {
    await gotoHome(page);
    const bad = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.day .row')].slice(0, 20);
      const problems: string[] = [];
      for (const row of rows) {
        const cells = [...row.querySelectorAll(':scope > .m')];
        const when = cells[4];
        if (!when) { problems.push('missing When cell'); continue; }
        const cs = getComputedStyle(when);
        if (!when.classList.contains('ts-col')) problems.push('When cell missing .ts-col class');
        if (!cs.fontVariantNumeric.includes('tabular')) problems.push(`When not tabular: "${when.textContent}"`);
        if (cs.textAlign !== 'right') problems.push(`When not right-aligned: "${when.textContent}"`);
        if (cs.whiteSpace !== 'nowrap') problems.push(`When not nowrap: "${when.textContent}"`);
        // Fixture sessions land close together in time, so the real overflow
        // condition may never trigger on this data — the class-presence +
        // fixed-width assertions above are the tightened, always-meaningful
        // guard (per the task brief); this scrollWidth check still runs as a
        // belt-and-suspenders regression guard whenever it CAN trigger.
        if (when.scrollWidth > when.clientWidth + 1) {
          problems.push(`When overflows its cell: "${when.textContent}" scrollWidth=${when.scrollWidth} clientWidth=${when.clientWidth}`);
        }
      }
      return problems;
    });
    expect(bad, bad.join('; ')).toEqual([]);
  });

  test('.ts-col computed width is the policy 9ch (regression guard — fails if the class is ever removed)', async ({ page }) => {
    await gotoHome(page);
    const { widthPx, chPx } = await page.evaluate(() => {
      const when = document.querySelector('.day .row .m.ts-col') as HTMLElement | null;
      if (!when) return { widthPx: -1, chPx: -1 };
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;font:12px var(--mono, monospace);';
      probe.textContent = '0';
      document.body.appendChild(probe);
      const chWidth = probe.getBoundingClientRect().width;
      probe.remove();
      return { widthPx: when.getBoundingClientRect().width, chPx: chWidth };
    });
    expect(widthPx, '.m.ts-col not found on a Home row').toBeGreaterThan(0);
    expect(Math.abs(widthPx - chPx * 9), `expected ~9ch (${chPx * 9}px), got ${widthPx}px`).toBeLessThan(3);
  });

  test('header cells register with their body columns (matching right edges, ±2px)', async ({ page }) => {
    await gotoHome(page);
    const bad = await page.evaluate(() => {
      const headEls = [...document.querySelectorAll('.colhead > span')];
      const firstRow = document.querySelector('.day .row');
      if (!firstRow) return ['no row found'];
      const rowEls = [firstRow.querySelector(':scope > .title'), ...firstRow.querySelectorAll(':scope > .m')];
      const problems: string[] = [];
      for (let i = 0; i < Math.min(headEls.length, rowEls.length); i++) {
        const h = headEls[i]; const r = rowEls[i];
        if (!h || !r) continue;
        const hr = h.getBoundingClientRect().right;
        const rr = r.getBoundingClientRect().right;
        if (Math.abs(hr - rr) > 2) {
          problems.push(`column ${i} (${h.textContent}): header right=${hr.toFixed(1)} vs row right=${rr.toFixed(1)}`);
        }
      }
      return problems;
    });
    expect(bad, bad.join('; ')).toEqual([]);
  });

  test('the "Session" header x-position equals the title column\'s x (±2px)', async ({ page }) => {
    await gotoHome(page);
    const { headX, titleX } = await page.evaluate(() => {
      const head = document.querySelector('.colhead > span:first-child');
      const title = document.querySelector('.day .row .title');
      return {
        headX: head ? head.getBoundingClientRect().left : NaN,
        titleX: title ? title.getBoundingClientRect().left : NaN,
      };
    });
    expect(Math.abs(headX - titleX), `Session header x=${headX} vs title column x=${titleX}`).toBeLessThanOrEqual(2);
  });
});

// ── (b) Session Overview: conversation-timeline vs files-touched row gaps ──

// NOTE on Files-touched coverage: the shared big fixture's generic Edit/Write
// tool_use payloads key their target as `path` (test/fixtures/gen-big-
// session.mjs), while OverviewMode's Files-touched aggregation reads
// `file_path` (the real Claude Code field name) — so `.trow` never renders
// under the Files-touched card on this fixture (a fixture/probe data-shape
// mismatch, not a layout bug; out of this task's touch list — the fixture
// generator is shared infra used by many other specs). Conversation-timeline
// and Files-touched render via the exact SAME `.trow` selector with no
// per-section override (confirmed below via a static source check), so
// measuring gap on the one that DOES render on this fixture (Conversation
// timeline) validates both — the same technique the brief applies to the
// When-column overflow probe.
test.describe('(b) Session Overview row rhythm', () => {
  async function trowGap(page: Page, headingSubstr: string): Promise<number> {
    return page.evaluate((needle) => {
      const cards = [...document.querySelectorAll('.card')];
      const card = cards.find((c) => c.querySelector('h3')?.textContent?.includes(needle));
      const row = card?.querySelector('.trow');
      if (!row) return NaN;
      const cs = getComputedStyle(row);
      // `.trow` is a two-child flex row (time · text) — column-gap is the
      // relevant axis; `gap` shorthand also sets it identically here.
      return parseFloat(cs.columnGap || cs.gap);
    }, headingSubstr);
  }

  test('.trow has exactly one defining CSS rule (no per-section override that could let Conversation-timeline and Files-touched diverge)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { REPO_ROOT } = await import('./helpers.ts');
    const css = fs.readFileSync(path.join(REPO_ROOT, 'src', 'styles.css'), 'utf8');
    const ruleStarts = [...css.matchAll(/(^|[,{}]\s*)\.trow\s*\{/g)];
    expect(ruleStarts.length, `expected exactly one ".trow {" rule, found ${ruleStarts.length}`).toBe(1);
  });

  test('conversation-timeline rows have gap >= --gap-2 (8px)', async ({ page }) => {
    await gotoFixtureOverview(page);
    const gap = await trowGap(page, 'Conversation timeline');
    const gap2 = await gapVarPx(page, '--gap-2');
    expect(gap, 'no .trow found under Conversation timeline card').not.toBeNaN();
    expect(gap, `gap=${gap}px must be >= --gap-2 (${gap2}px)`).toBeGreaterThanOrEqual(gap2);
  });

  test('conversation-timeline (and by the single-rule guarantee above, files-touched too) has gap <= --gap-4 (16px)', async ({ page }) => {
    await gotoFixtureOverview(page);
    const gap = await trowGap(page, 'Conversation timeline');
    const gap4 = await gapVarPx(page, '--gap-4');
    expect(gap, 'no .trow found under Conversation timeline card').not.toBeNaN();
    expect(gap, `gap=${gap}px must be <= --gap-4 (${gap4}px)`).toBeLessThanOrEqual(gap4);
  });

  test('the shared .trow gap draws from the spacing scale (RHYTHM — not an arbitrary one-off px value)', async ({ page }) => {
    await gotoFixtureOverview(page);
    const gap = await trowGap(page, 'Conversation timeline');
    const scaleSteps = await Promise.all(
      ['--gap-1', '--gap-2', '--gap-3', '--gap-4', '--gap-5'].map((n) => gapVarPx(page, n)),
    );
    expect(scaleSteps, `gap=${gap}px is not one of the --gap-N scale steps (${scaleSteps.join(', ')})`).toContain(gap);
  });
});

// ── (c) Refine by-type chips: gap + no-overlap wrap at 1024px ──────────────

test.describe('(c) Refine by-type chips', () => {
  test('by-type chip row gap === --gap-2 (8px)', async ({ page }) => {
    await gotoFixtureRefine(page);
    const row = page.locator('.refine-bytype');
    await expect(row).toBeVisible();
    const gap = await row.evaluate((el) => parseFloat(getComputedStyle(el).columnGap || getComputedStyle(el).gap));
    const gap2 = await gapVarPx(page, '--gap-2');
    expect(gap, `by-type chip gap=${gap}px must equal --gap-2 (${gap2}px)`).toBeCloseTo(gap2, 1);
  });

  test('by-type chips wrap to a second row at 1024px without overlapping', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await gotoFixtureRefine(page);
    const rects = await page.locator('.refine-bytype .bytype-chip, .refine-bytype .bytype-label').evaluateAll(
      (els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, right: r.right, bottom: r.bottom })),
    );
    expect(rects.length, 'expected multiple by-type chips on the fixture (5 message kinds)').toBeGreaterThan(1);
    const overlapping: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]; const b = rects[j];
        const xOverlap = a.x < b.right - 0.5 && b.x < a.right - 0.5;
        const yOverlap = a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5;
        if (xOverlap && yOverlap) overlapping.push(`chip ${i} overlaps chip ${j}`);
      }
    }
    expect(overlapping, overlapping.join('; ')).toEqual([]);
  });
});

// ── (d) Insights Top Sessions table: no horizontal cutoff at any width ─────

for (const width of WIDTHS) {
  test(`(d) no horizontal overflow at ${width}px — Insights Overview (Top Sessions table)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoInsights(page);
    await expect(page.getByRole('heading', { name: /Top sessions by cost/ })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    expect(overflow, `documentElement.scrollWidth exceeds innerWidth at ${width}px on Insights Overview`).toBe(true);
  });
}

// ── (e) Every reachable route/mode at all 3 widths: no horizontal overflow ─
// One test per width (not per route×width) to keep navigation overhead down;
// each collects every failing route into a single assertion.

interface RouteCase { label: string; go: (page: Page) => Promise<void>; }

function sessionRoutes(): RouteCase[] {
  return [
    { label: 'session/overview', go: gotoFixtureOverview },
    {
      label: 'session/playback',
      go: async (page) => {
        await gotoFixtureOverview(page);
        await page.locator('button[title^="Playback"]').click();
        await expect(page.locator('.timeline')).toBeVisible();
      },
    },
    { label: 'session/refine', go: gotoFixtureRefine },
    {
      label: 'session/security-check',
      go: async (page) => {
        await gotoFixtureOverview(page);
        await page.locator('button[title="Security Check"]').click();
        await expect(page.locator('.modal .sec-summary, .modal .error-banner')).toBeVisible();
      },
    },
  ];
}

function insightsRoutes(): RouteCase[] {
  return [
    { label: 'insights/overview', go: gotoInsights },
    {
      label: 'insights/explore',
      go: async (page) => {
        await gotoInsights(page);
        await page.locator('.tabs .tab', { hasText: 'Explore' }).click();
        await page.waitForTimeout(50); // tab switch is synchronous state; no network wait needed
      },
    },
    {
      label: 'insights/content',
      go: async (page) => {
        await gotoInsights(page);
        await page.locator('.tabs .tab', { hasText: 'Content' }).click();
        await page.waitForTimeout(50);
      },
    },
  ];
}

function projectRoutes(projectId: number): RouteCase[] {
  const base = `${state.baseURL}/project/${projectId}`;
  return [
    {
      label: 'project/overview',
      go: async (page) => {
        await page.goto(base);
        await expect(page.locator('.project-detail .kpis').first()).toBeVisible();
      },
    },
    {
      label: 'project/sessions',
      go: async (page) => {
        await page.goto(base);
        await expect(page.locator('.project-detail .kpis').first()).toBeVisible();
        await page.locator('.tabs .tab', { hasText: 'Sessions' }).click();
        await expect(page.locator('.session-list')).toBeVisible();
      },
    },
    {
      label: 'project/explore',
      go: async (page) => {
        await page.goto(`${base}/explore`);
        await page.waitForTimeout(50);
      },
    },
    {
      label: 'project/content',
      go: async (page) => {
        await page.goto(`${base}/content`);
        await page.waitForTimeout(50);
      },
    },
  ];
}

for (const width of WIDTHS) {
  test(`(e) no horizontal overflow at ${width}px — every reachable route/mode`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const projectId = await fixtureProjectId();
    const cases: RouteCase[] = [
      { label: 'home', go: gotoHome },
      ...projectRoutes(projectId),
      ...sessionRoutes(),
      ...insightsRoutes(),
    ];
    const failing: string[] = [];
    for (const c of cases) {
      await c.go(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      if (!overflow) {
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        failing.push(`${c.label} (scrollWidth=${scrollWidth} > innerWidth=${width})`);
      }
    }
    expect(failing, failing.join('; ')).toEqual([]);
  });
}
