import { defineConfig, devices } from '@playwright/test';

/**
 * The desktop app's screens and document flow, run in Chromium against the real editor with the
 * shell faked in the page (`e2e/desktop/mockShell.ts`). Its own port: 5180 is the web suite's.
 */
export default defineConfig({
  testDir: './e2e/desktop',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never', outputFolder: 'playwright-report-desktop' }]] : [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'on-first-retry',
  },
  // Every engine the app ships to; `PLAYWRIGHT_BROWSER=<name>` runs one (how CI shards).
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ].filter((project) => !process.env.PLAYWRIGHT_BROWSER || project.name === process.env.PLAYWRIGHT_BROWSER),
  webServer: {
    command: 'npm run dev -- --mode desktop --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
