#!/usr/bin/env node
// test/e2e/walk.mjs — release-walk capture script (spec §5.2 stage 1, Task 18).
//
// A standalone Node script, NOT a Playwright test: it drives Playwright's
// `chromium` API directly from the installed `@playwright/test` devDependency
// (playwright test's assertion/reporter machinery is not used — a probe
// "failing" here is data in a report, never a thrown assertion). It walks
// every route/mode the spec calls out, at the same 3 reference widths
// test/e2e/helpers.ts uses (1024/1366/1728 — laptop / common desktop / wide
// desktop), and for each (route, width) pair writes:
//   <slug>-<width>.png    full-page screenshot
//   <slug>-<width>.json   per-page probe report (overflow / popover clip /
//                         tabular-nums coverage / console errors)
// plus one aggregate `walk-report.json` (pass/fail counts per probe, and the
// full per-page list) in the same --out directory.
//
// Usage:
//   npm run walk -- --base http://localhost:4173 --out /tmp/chronicle-walk/
//
// Read-only by design: this is meant to run against a REAL dev server (the
// maintainer's live data, or a throwaway copy of ~/.chronicle/chronicle.db).
// It only navigates, opens read-only UI (search modal, select-mode toggle,
// InfoTip hover), and screenshots — it never clicks Remove/Delete/Sync or any
// other destructive/mutating control.
//
// Resilience: route discovery and every per-page `setup()` are wrapped so a
// 404, a missing project/session (empty DB), or a mode that doesn't render on
// this data lands as `{error: "..."}` in that page's JSON + the aggregate
// report instead of crashing the walk. `walk-report.json` is always written;
// the process exits 0 unless literally zero (route, width) pairs rendered, in
// which case it exits 1 so a CI/audit caller can tell "ran but found problems"
// apart from "never worked at all".
import { chromium } from '@playwright/test';
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

// Same reference widths as test/e2e/helpers.ts WIDTHS (kept as a literal here
// rather than importing that .ts helper, so this script has zero project
// source dependencies beyond @playwright/test — it must run standalone via
// `node test/e2e/walk.mjs`, not through the Playwright test runner/tsconfig).
const WIDTHS = [1024, 1366, 1728];
const HEIGHT = 900;
const NAV_TIMEOUT_MS = 15_000;

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'http://localhost:4173' },
      out: { type: 'string', default: '/tmp/chronicle-walk/' },
    },
  });
  return { base: String(values.base).replace(/\/+$/, ''), out: String(values.out) };
}

// ---- Route discovery: pick the first project (preferring one with sessions)
// and its first session, over the app's own read-only API — no DB access, no
// mutation. Missing data degrades to `null`, not a thrown error; routes that
// depend on a missing id are recorded as an error per-route instead (see
// buildRoutes below), so a fresh/empty Chronicle instance still produces a
// complete (if mostly-errored) report rather than crashing.
async function discoverContext(base) {
  const ctx = { projectId: null, sessionId: null, notes: [] };
  try {
    const res = await fetch(`${base}/api/projects`);
    if (!res.ok) throw new Error(`GET /api/projects -> ${res.status}`);
    const projects = await res.json();
    const withSessions = projects.find((p) => p.session_count > 0) ?? projects[0] ?? null;
    if (withSessions) ctx.projectId = withSessions.id;
    else ctx.notes.push('no projects returned by /api/projects');
  } catch (err) {
    ctx.notes.push(`project discovery failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (ctx.projectId != null) {
    try {
      const res = await fetch(`${base}/api/projects/${ctx.projectId}`);
      if (!res.ok) throw new Error(`GET /api/projects/${ctx.projectId} -> ${res.status}`);
      const body = await res.json();
      const first = Array.isArray(body.sessions) ? body.sessions[0] : null;
      if (first) ctx.sessionId = first.id;
      else ctx.notes.push(`project ${ctx.projectId} has no sessions`);
    } catch (err) {
      ctx.notes.push(`session discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return ctx;
}

// ---- Route list: the exact set from the task brief, resolved against the
// discovered project/session ids. Selectors below are read from the current
// source (src/App.tsx, src/SessionView.tsx, src/HomeDashboard.tsx,
// src/SessionSelect.tsx, src/RecentLedger.tsx) and mirror the stable
// selectors test/e2e/*.spec.ts already uses for the same surfaces, so this
// script stays in sync with what the E2E suite considers "the real markup".
function buildRoutes(base, ctx) {
  const routes = [];
  const missing = (reason) => ({ setup: async () => { throw new Error(reason); } });

  routes.push({
    slug: 'home',
    async setup(page) {
      // `/` is the Insights hub (Overview/Explore/Content). The recent-sessions
      // ledger moved OFF Home to /projects in the D1/D2 IA reshape (#98); wait
      // on the Overview body marker, not the ledger. See spec/surface-contract.md.
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.insights-page', { timeout: NAV_TIMEOUT_MS });
    },
  });

  routes.push({
    slug: 'projects',
    async setup(page) {
      // Wait for real content (the ledger), not just the `.page` shell — the
      // shell renders an immediate "Loading…" placeholder, so screenshotting on
      // `.page` alone captures a loading state, not the /projects surface.
      await page.goto(`${base}/projects`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.recent-ledger', { timeout: NAV_TIMEOUT_MS });
    },
  });

  routes.push({
    slug: 'project',
    ...(ctx.projectId != null
      ? {
          async setup(page) {
            await page.goto(`${base}/project/${ctx.projectId}`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('.project-detail', { timeout: NAV_TIMEOUT_MS });
          },
        }
      : missing(`no project discovered via /api/projects (${ctx.notes.join('; ') || 'empty DB?'})`)),
  });

  const gotoSessionOverview = async (page) => {
    await page.goto(`${base}/session/${encodeURIComponent(ctx.sessionId)}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar .sb-item.mode', { timeout: NAV_TIMEOUT_MS });
  };
  if (ctx.sessionId != null) {
    routes.push({ slug: 'session-overview', setup: gotoSessionOverview });
    routes.push({
      slug: 'session-playback',
      async setup(page) {
        await gotoSessionOverview(page);
        await page.locator('button[title^="Playback"]').click();
        await page.waitForSelector('.timeline', { timeout: NAV_TIMEOUT_MS });
      },
    });
    routes.push({
      slug: 'session-refine',
      async setup(page) {
        await gotoSessionOverview(page);
        await page.locator('button[title^="Refine"]').click();
        await page.waitForSelector('.refine', { timeout: NAV_TIMEOUT_MS });
      },
    });
    routes.push({
      slug: 'session-security',
      async setup(page) {
        await gotoSessionOverview(page);
        await page.locator('button[title="Security Check"]').click();
        await page.waitForSelector('.modal', { timeout: NAV_TIMEOUT_MS });
      },
    });
  } else {
    const reason = `no session discovered for project ${ctx.projectId} (${ctx.notes.join('; ') || 'no sessions?'})`;
    for (const slug of ['session-overview', 'session-playback', 'session-refine', 'session-security']) {
      routes.push({ slug, ...missing(reason) });
    }
  }

  const gotoInsights = async (page) => {
    // The Insights hub is now the Home hub at `/` (Overview/Explore/Content tabs).
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tabs .tab', { timeout: NAV_TIMEOUT_MS });
  };
  routes.push({ slug: 'insights-overview', setup: gotoInsights });
  routes.push({
    slug: 'insights-explore',
    async setup(page) {
      await gotoInsights(page);
      await page.locator('.tabs .tab', { hasText: 'Explore' }).click();
      await page.waitForTimeout(100); // tab switch is synchronous client state, no network wait
    },
  });
  routes.push({
    slug: 'insights-content',
    async setup(page) {
      await gotoInsights(page);
      await page.locator('.tabs .tab', { hasText: 'Content' }).click();
      await page.waitForTimeout(100);
    },
  });

  routes.push({
    slug: 'search-modal',
    async setup(page) {
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
      await page.locator('button.icon-btn[title^="Search"]').click();
      await page.waitForSelector('.search-modal', { timeout: NAV_TIMEOUT_MS });
    },
  });

  routes.push({
    slug: 'select-mode',
    async setup(page) {
      // Session multi-select now lives on /projects (ledger moved there in #98),
      // and the resting "☑ Select" opens the shared `.command-bar` — the old
      // boxed `.select-toolbar` was removed. See spec/surface-contract.md.
      await page.goto(`${base}/projects`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.recent-ledger', { timeout: NAV_TIMEOUT_MS });
      const btn = page.locator('.recent-ledger').getByRole('button', { name: '☑ Select', exact: true });
      if ((await btn.count()) === 0) throw new Error('no "☑ Select" button in the /projects ledger (no sessions imported?)');
      await btn.first().click();
      await page.waitForSelector('.command-bar', { timeout: NAV_TIMEOUT_MS });
    },
  });

  return routes;
}

// ---- Probes ----------------------------------------------------------------

// (a) Overflow: documentElement.scrollWidth must not exceed innerWidth, plus
// up to 20 offending elements (by bounding-box right edge) when it does.
async function probeOverflow(page) {
  return page.evaluate(() => {
    const scrollWidth = document.documentElement.scrollWidth;
    const innerWidth = window.innerWidth;
    const pass = scrollWidth <= innerWidth;
    const offenders = [];
    if (!pass) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.right > innerWidth + 1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            class: typeof el.className === 'string' ? el.className : '',
            right: Math.round(r.right),
          });
          if (offenders.length >= 20) break;
        }
      }
    }
    return { pass, scrollWidth, innerWidth, offenders };
  });
}

// (b) Popover clip: if the page has an InfoTip (`.info-tip`), open the first
// one and bounding-box test its `.info-bubble` — must stay fully inside the
// viewport horizontally and must open downward (never flip above its
// trigger), mirroring test/e2e/infotip.spec.ts's assertions. Pages with no
// InfoTip report `present: false, pass: true` (nothing to check).
async function probePopoverClip(page, width) {
  const tipCount = await page.locator('.info-tip').count();
  if (tipCount === 0) return { present: false, pass: true, note: 'no .info-tip on this page' };

  const trigger = page.locator('.info-tip').first();
  const triggerBox = await trigger.boundingBox();
  const bubble = page.locator('.info-bubble');
  let visible = false;
  let hoverError = null;
  try {
    // Short timeout, not the page default: an .info-tip elsewhere in the DOM
    // can be legitimately un-interactable right now (e.g. obscured by an open
    // modal's backdrop on the security-check route) — that's a real "can't
    // check this probe here" outcome, not a script crash.
    await trigger.hover({ timeout: 3000 });
    await bubble.waitFor({ state: 'visible', timeout: 2000 });
    visible = true;
  } catch (err) {
    hoverError = err instanceof Error ? err.message.split('\n')[0] : String(err);
  }

  let result;
  if (!visible || !triggerBox) {
    result = {
      present: true, pass: false,
      note: hoverError
        ? `.info-tip present but not hoverable/openable right now: ${hoverError}`
        : '.info-tip present but .info-bubble never became visible on hover',
    };
  } else {
    const bubbleBox = await bubble.boundingBox();
    const insideLeft = bubbleBox ? bubbleBox.x >= -0.5 : false;
    const insideRight = bubbleBox ? bubbleBox.x + bubbleBox.width <= width + 0.5 : false;
    const opensDown = bubbleBox ? bubbleBox.y >= triggerBox.y + triggerBox.height - 1 : false;
    result = {
      present: true,
      pass: insideLeft && insideRight && opensDown,
      triggerBox, bubbleBox, insideLeft, insideRight, opensDown,
    };
  }

  // Dismiss so it never leaks into the screenshot or a later probe.
  await page.mouse.move(0, 0);
  await bubble.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
  return result;
}

// (c) tabular-nums coverage: every `.num-col`/`.ts-col` cell (the design
// system's numeric-column policy classes, see CLAUDE.md's design-QA rubric)
// must compute `font-variant-numeric` containing "tabular". Pages with no
// numeric cells report `total: 0, pass: true` (vacuously fine).
async function probeTabularNums(page) {
  return page.evaluate(() => {
    const cells = [...document.querySelectorAll('.num-col, .ts-col')];
    const failing = [];
    for (const cell of cells) {
      const cs = getComputedStyle(cell);
      if (!cs.fontVariantNumeric.includes('tabular')) {
        failing.push({ text: (cell.textContent || '').slice(0, 40), fontVariantNumeric: cs.fontVariantNumeric });
      }
    }
    return { total: cells.length, failing: failing.slice(0, 20), pass: failing.length === 0 };
  });
}

async function runProbes(page, width) {
  return {
    overflow: await probeOverflow(page),
    popoverClip: await probePopoverClip(page, width),
    tabularNums: await probeTabularNums(page),
  };
}

// ---- Main -------------------------------------------------------------------

function summarize(pages) {
  const byProbe = {
    overflow: { pass: 0, fail: 0 },
    popoverClip: { pass: 0, fail: 0 },
    tabularNums: { pass: 0, fail: 0 },
  };
  let renderedOk = 0;
  for (const p of pages) {
    if (!p.ok) continue;
    renderedOk++;
    for (const key of Object.keys(byProbe)) {
      const probe = p.probes?.[key];
      if (!probe) continue;
      byProbe[key][probe.pass ? 'pass' : 'fail']++;
    }
  }
  return { totalPages: pages.length, renderedOk, renderedError: pages.length - renderedOk, byProbe };
}

async function main() {
  const { base, out } = parseCliArgs();
  fs.mkdirSync(out, { recursive: true });

  console.log(`[walk] base=${base} out=${out}`);
  console.log('[walk] discovering first project/session via the read-only API...');
  const ctx = await discoverContext(base);
  console.log(`[walk] projectId=${ctx.projectId} sessionId=${ctx.sessionId}${ctx.notes.length ? ` notes=${ctx.notes.join('; ')}` : ''}`);

  const routes = buildRoutes(base, ctx);
  const browser = await chromium.launch();
  const pages = [];
  let renderedCount = 0;

  try {
    for (const width of WIDTHS) {
      for (const route of routes) {
        const slug = `${route.slug}-${width}`;
        const pageReport = { slug, route: route.slug, width, ok: false };
        const context = await browser.newContext({ viewport: { width, height: HEIGHT } });
        const page = await context.newPage();
        page.setDefaultTimeout(NAV_TIMEOUT_MS);
        const consoleErrors = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push({ type: 'console.error', text: msg.text() });
        });
        page.on('pageerror', (err) => {
          consoleErrors.push({ type: 'pageerror', text: String(err) });
        });

        try {
          await route.setup(page);
          const probes = await runProbes(page, width);
          const pngPath = path.join(out, `${slug}.png`);
          await page.screenshot({ path: pngPath, fullPage: true });
          pageReport.ok = true;
          pageReport.probes = probes;
          pageReport.screenshot = path.basename(pngPath);
          renderedCount++;
        } catch (err) {
          pageReport.error = err instanceof Error ? err.message : String(err);
        }
        pageReport.consoleErrors = consoleErrors;

        fs.writeFileSync(path.join(out, `${slug}.json`), JSON.stringify(pageReport, null, 2));
        pages.push(pageReport);
        console.log(`[walk] ${slug}: ${pageReport.ok ? 'ok' : `ERROR: ${pageReport.error}`}`);

        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  const report = {
    base, out, generatedAt: new Date().toISOString(), widths: WIDTHS,
    context: { projectId: ctx.projectId, sessionId: ctx.sessionId, notes: ctx.notes },
    summary: summarize(pages),
    pages,
  };
  fs.writeFileSync(path.join(out, 'walk-report.json'), JSON.stringify(report, null, 2));

  console.log(`[walk] wrote ${pages.length} page report(s) + walk-report.json to ${out}`);
  console.log(`[walk] rendered ${renderedCount}/${pages.length} pages`);

  if (renderedCount === 0) {
    console.error('[walk] FATAL: zero (route, width) pairs rendered — see walk-report.json for errors');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[walk] unexpected fatal error:', err);
  process.exit(1);
});
