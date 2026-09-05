// Playwright E2E config (spec §5.1 / task-6). No `webServer` block — see
// test/e2e/helpers.ts's top comment for why the server + fixture seed happen
// in `globalSetup` instead (avoids racing "server listening" against
// "fixture imported"). Each spec reads the seeded server's baseURL via
// `readSeedState()` rather than `use.baseURL`, since that URL is only known
// once globalSetup (which runs after this config is loaded) has picked a
// free port.
//
// CHI #245 — the suite runs PARALLEL. `fullyParallel` spreads the tests of a
// single file across workers too, not just whole files; the handful of specs
// that genuinely depend on order within their file declare
// `test.describe.configure({ mode: 'serial' })` themselves. Two workers
// because the CI runner has 2 vCPU and the suite is CPU-bound on Chromium,
// so a third worker on that box would only contend; the parallelism above
// that comes from sharding the job across runners (.github/workflows/ci.yml).
// Each worker gets its own seeded Chronicle instance (test/e2e/helpers.ts),
// so workers never share a server or a database.
//
// `retries: 1` everywhere, paired with `failOnFlakyTests`: a genuine blip
// does not fail the gate, but a spec that passes ONLY on its retry fails the
// job with a flaky verdict. A race is then reported as a race instead of
// being absorbed by the retry.
//
// test/e2e-parallel-config.test.mjs pins all of this so it cannot drift back.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  failOnFlakyTests: true,
  workers: 2,
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
