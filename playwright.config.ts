// Playwright E2E config (spec §5.1 / task-6). No `webServer` block — see
// test/e2e/helpers.ts's top comment for why the server + fixture seed happen
// in `globalSetup` instead (avoids racing "server listening" against
// "fixture imported"). Each spec reads the seeded server's baseURL via
// `readSeedState()` rather than `use.baseURL`, since that URL is only known
// once globalSetup (which runs after this config is loaded) has picked a
// free port.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  globalSetup: './test/e2e/global-setup.ts',
  globalTeardown: './test/e2e/global-teardown.ts',
  use: {
    viewport: { width: 1366, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
