import { defineConfig, devices } from '@playwright/test';

/**
 * The assembled web deploy, served the way GitHub Pages serves it: under /draft-canvas/, with the
 * editor nested at /draft-canvas/editor/.
 *
 * None of this is visible to the other two suites. `playwright.config.ts` runs against `vite dev`
 * at the root, and `playwright.dist.config.ts` serves `dist/` at the root — so neither can catch a
 * relative URL that is wrong by one directory, a marketing bundle that leaked into the editor, or
 * a legacy editor link that stopped being forwarded. Those are exactly the failures that only
 * appear in production, which is why this config exists.
 */
// A preview server left running from an earlier build (`reuseExistingServer`) serves the site as it
// stood then, and the suite would quietly pass or fail against stale files. `DC_WEB_PORT=4199` puts
// a run on a port of its own, with a fresh build behind it.
const port = Number(process.env.DC_WEB_PORT ?? 4174);

export default defineConfig({
  testDir: './e2e',
  testMatch: 'web-deploy.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // Its own report folder: `npm run e2e`, `e2e:offline` and `e2e:web` can run in one CI job, and
  // sharing the default output folder would let each run overwrite the last one's report.
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: 'playwright-report-web', open: 'never' }]]
    : [['list']],
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run site:preview -- ${port}`,
    url: `http://localhost:${port}/draft-canvas/`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
