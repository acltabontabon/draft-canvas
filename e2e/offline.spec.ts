import { expect, test } from '@playwright/test';

/**
 * Phase 6 — the core promise: after Draft Canvas has loaded once, it keeps
 * working with no network at all. Runs against `dist/` via
 * `playwright.dist.config.ts`, since `vite dev` never registers the Service
 * Worker this depends on.
 */
test.describe('offline availability', () => {
  test('a diagram survives an offline reload', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Recently edited' })).toBeVisible();

    // Let the Service Worker finish precaching the shell before going offline
    // — the same thing a real first visit waits through, just made explicit.
    await page.waitForFunction(async () => {
      const registration = await navigator.serviceWorker.ready;
      return !!registration.active;
    });

    await page.getByRole('button', { name: 'New canvas' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await page.getByLabel('Diagram title').fill('Offline Test');
    await page.getByLabel('Diagram title').blur();
    await expect(page.locator('.dc-save')).toContainText('Saved locally');

    await context.setOffline(true);
    await page.reload();

    // The shell itself loaded from cache, not the network — a reload always
    // returns to the library screen (see critical-journey.spec.ts) — and the
    // diagram is still there, because IndexedDB never depended on the network.
    await expect(page.getByRole('heading', { name: 'Recently edited' })).toBeVisible();
    await expect(page.locator('.dc-library-item', { hasText: 'Offline Test' })).toBeVisible();

    await context.setOffline(false);
  });
});
