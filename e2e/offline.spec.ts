import { expect, test } from '@playwright/test';
import { siVuedotjs } from 'simple-icons';
import { create } from './canvas';

/**
 * The core promise: after Draft Canvas has loaded once, it keeps
 * working with no network at all. Runs against `dist/` via
 * `playwright.dist.config.ts`, since `vite dev` never registers the Service
 * Worker this depends on.
 */
test.describe('offline availability', () => {
  test('a diagram survives an offline reload', async ({ page, context, browserName }) => {
    // Playwright drives a service worker's offline behaviour only in Chromium (WebKit fails the
    // reload with an internal error, Firefox has no service-worker support in its driver).
    test.skip(browserName !== 'chromium', 'offline emulation with a service worker is Chromium-only in Playwright');
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'New canvas' })).toBeVisible();

    // Let the Service Worker finish precaching the shell before going offline
    // — the same thing a real first visit waits through, just made explicit.
    // `page.waitForFunction` does not await an async predicate (the Promise itself is truthy), so
    // the wait is a poll over `page.evaluate`, which does.
    await expect
      .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.ready).active), { timeout: 30_000 })
      .toBe(true);

    await page.getByRole('button', { name: 'New canvas' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await page.getByLabel('Diagram title').fill('Offline Test');
    await page.getByLabel('Diagram title').blur();
    await expect(page.locator('.dc-save')).toContainText('Saved locally');

    await context.setOffline(true);
    await page.reload();

    // The shell itself loaded from cache, not the network; the address still names the canvas, so
    // the reload comes straight back to it — the editor chunk from the cache, the diagram from
    // IndexedDB, which never depended on the network.
    await expect(page.getByLabel('Diagram title')).toHaveValue('Offline Test');
    // This artwork has never been used in the page. Its lazy chunk must already be available
    // from the app-shell cache, even when it is first requested after going offline.
    await create(page, 'Service', { x: 400, y: 300 });
    const node = page.locator('.dc-node').first();
    await node.click();
    await page.locator('.dc-element-inspector').getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Edit details…' }).click();
    const technology = page.getByRole('combobox', { name: 'Technology', exact: true });
    await technology.fill('vuejs');
    await page.getByRole('option', { name: 'Vue.js', exact: true }).click();
    await expect.poll(() => node.locator('.dc-node-surface path').evaluateAll(
      (paths, expected) => paths.some((path) => path.getAttribute('d') === expected), siVuedotjs.path,
    )).toBe(true);
    await page.keyboard.press('Escape');
    // Export is a separate chunk again, fetched on demand — it must come from the cache too.
    await page.keyboard.press('ControlOrMeta+e');
    await expect(page.getByRole('dialog', { name: /export/i })).toBeVisible();
    await page.keyboard.press('Escape');

    // And the Library, one step back, lists it.
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await expect(page.getByRole('heading', { name: 'Recently edited' })).toBeVisible();
    await expect(page.locator('.dc-library-item', { hasText: 'Offline Test' })).toBeVisible();

    await context.setOffline(false);
  });
});
