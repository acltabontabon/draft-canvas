import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // `offline.spec.ts` runs only against `dist/` via `playwright.dist.config.ts` (`npm run e2e:offline`) —
  // `vite dev` never registers the Service Worker it depends on, so it hangs here instead of failing fast.
  // `desktop/` needs the desktop build and a faked shell: `playwright.desktop.config.ts` (`npm run e2e:desktop`).
  // `web-deploy.spec.ts` is about the assembled artifact served under /draft-canvas/, which is the
  // one thing this config cannot produce: it serves the app alone, at the root, from `vite dev`.
  // `playwright.web.config.ts` (`npm run e2e:web`).
  testIgnore: ['offline.spec.ts', 'web-deploy.spec.ts', '**/e2e/desktop/**'],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5180',
    trace: 'on-first-retry',
    // Downloads are asserted in the export tests.
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev -- --port 5180 --strictPort',
    url: 'http://localhost:5180',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
