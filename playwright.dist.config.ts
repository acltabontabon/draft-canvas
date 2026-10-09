import { defineConfig, devices } from '@playwright/test';

/**
 * The Service Worker (Phase 6) only exists in a real build — `vite dev`
 * never registers it, so the main `playwright.config.ts` suite (which runs
 * against `vite dev`) can't see any of this. This config builds and serves
 * `dist/` instead, on its own port, and runs only the offline-availability
 * spec against it.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: 'offline.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // A distinct HTML report folder from the main suite's — both configs can run in the same CI job
  // (`npm run e2e` then `npm run e2e:offline`), and sharing `playwright-report/`'s default output
  // folder would let the second run silently overwrite the first's report.
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: 'playwright-report-offline', open: 'never' }]]
    : [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5190',
    trace: 'on-first-retry',
  },
  // Every engine the app ships to; `PLAYWRIGHT_BROWSER=<name>` runs one (how CI shards).
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ].filter((project) => !process.env.PLAYWRIGHT_BROWSER || project.name === process.env.PLAYWRIGHT_BROWSER),
  webServer: {
    command: `${process.env.DC_TEST_BUILT === '1' ? '' : 'npm run build && '}npm run preview -- --port 5190 --strictPort`,
    url: 'http://localhost:5190',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
