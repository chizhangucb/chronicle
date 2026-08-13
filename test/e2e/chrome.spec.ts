// Task 17 E2E: live visibility + chrome oddments (spec §2.6).
//
// Flake discipline: every wait is on a visible DOM condition (auto-retrying
// `expect`) or an `expect.poll` against a real server response, never a bare
// sleep.
import { test, expect, type Page } from '@playwright/test';
import { readSeedState } from './helpers.ts';

const state = readSeedState();

async function fixtureProjectId(): Promise<number> {
  const res = await fetch(`${state.baseURL}/api/sessions/${encodeURIComponent(state.sessionId)}/resolve`);
  const body = (await res.json()) as { project_id: number };
  return body.project_id;
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/');
  await expect(page.locator('.recent-ledger .day .row').first()).toBeVisible();
}

async function gotoProjects(page: Page): Promise<void> {
  await page.goto(state.baseURL + '/projects');
  await expect(page.locator('.rail-proj').first()).toBeVisible();
}

async function gotoProject(page: Page, projectId: number): Promise<void> {
  await page.goto(`${state.baseURL}/project/${projectId}`);
  await expect(page.locator('.project-detail .kpis').first()).toBeVisible();
}

async function gotoSession(page: Page): Promise<void> {
  await page.goto(`${state.baseURL}/session/${encodeURIComponent(state.sessionId)}`);
  await expect(page.getByRole('heading', { name: /Files touched/ })).toBeVisible();
}

test.describe('T17.1 — topbar sync indicator on every page', () => {
  test('synced indicator is present on Home, Projects, a project page, and a session page', async ({ page }) => {
    const projectId = await fixtureProjectId();

    await gotoHome(page);
    await expect(page.locator('button[title="Sync now"]')).toBeVisible();

    await gotoProjects(page);
    await expect(page.locator('button[title="Sync now"]')).toBeVisible();

    await gotoProject(page, projectId);
    await expect(page.locator('button[title="Sync now"]')).toBeVisible();

    await gotoSession(page);
    await expect(page.locator('button[title="Sync now"]')).toBeVisible();
  });

  test('clicking the sync indicator triggers a manual sync', async ({ page }) => {
    await gotoHome(page);
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/autosync/run') && r.request().method() === 'POST'),
      page.locator('button[title="Sync now"]').click(),
    ]);
    expect(res.ok()).toBe(true);
  });
});

test.describe('T17.2 — dead "← Projects" nav removed', () => {
  test('no "← Projects" back link anywhere (home, projects, project, session)', async ({ page }) => {
    const projectId = await fixtureProjectId();

    for (const go of [
      () => gotoHome(page),
      () => gotoProjects(page),
      () => gotoProject(page, projectId),
      () => gotoSession(page),
    ]) {
      await go();
      const bodyText = await page.locator('body').innerText();
      expect(bodyText).not.toMatch(/←\s*Projects/);
    }
  });
});

test.describe('T17.6 — project gear menu drops "View Details"', () => {
  test('the project card gear menu has no View Details item', async ({ page }) => {
    await gotoProjects(page);
    await page.locator('.rail-proj button[title="Project options"]').first().click();
    await expect(page.locator('.menu-pop')).toBeVisible();
    await expect(page.locator('.menu-pop .menu-item', { hasText: 'View Details' })).toHaveCount(0);
    // The menu still has its other actions (sanity: we opened the right menu).
    await expect(page.locator('.menu-pop .menu-item', { hasText: 'Sync Update' })).toBeVisible();
  });
});

test.describe('T17.8 — search scope labels', () => {
  test('the search palette labels the tool-call scope "Tools", not "Code"', async ({ page }) => {
    await gotoHome(page);
    await page.locator('button.icon-btn[title^="Search"]').click();
    await expect(page.locator('.search-modal')).toBeVisible();
    await expect(page.locator('.search-tabs .chip', { hasText: 'Tools' })).toBeVisible();
    await expect(page.locator('.search-tabs .chip', { hasText: /^Code$/ })).toHaveCount(0);
    await expect(page.locator('.search-tabs .chip', { hasText: 'Chat' })).toBeVisible();
  });
});

test.describe('T17.3 — session Overview live dot', () => {
  test('shows a live dot when a live watcher is open for the session', async ({ page }) => {
    await gotoSession(page);
    // No live dot before any watcher exists.
    await expect(page.locator('.ov-name-row .live-dot.on')).toHaveCount(0);

    // Open a raw SSE stream against this session — the server registers a
    // live watcher regardless of client-side liveCandidate gating (same
    // EventSource trick as home.spec.ts's "live session shows a pulsing dot").
    await page.evaluate((id) => new Promise<boolean>((resolve) => {
      const es = new EventSource(`/api/sessions/${encodeURIComponent(id)}/live`);
      (window as unknown as { __es?: EventSource }).__es = es;
      es.onmessage = () => resolve(true);
      es.onopen = () => resolve(true);
      setTimeout(() => resolve(true), 3000);
    }), state.sessionId);

    // Confirm the server registered the watcher before asserting the UI.
    await expect.poll(async () => {
      const r = await page.request.get(`${state.baseURL}/api/live/status`);
      const list = (await r.json()) as { sessionId: string }[];
      return list.some((w) => w.sessionId === state.sessionId);
    }).toBe(true);

    // OverviewMode polls /api/live/status every 5s — poll.toBeVisible retries
    // past that window.
    await expect(page.locator('.ov-name-row .live-dot.on')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => (window as unknown as { __es?: EventSource }).__es?.close());
  });
});

test.describe('T17.4 — labeled Rename affordance', () => {
  test('the rename control is a labeled "Rename" button with an InfoTip explaining scope', async ({ page }) => {
    await gotoSession(page);
    const renameBtn = page.locator('.ov-name-row button', { hasText: 'Rename' });
    await expect(renameBtn).toBeVisible();
    const tip = page.locator('.ov-name-row button.info-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute('aria-label', /Renames in Chronicle only.*Claude Code's \/rename/);
  });
});
