import { expect, type Page } from '@playwright/test';
import { serveStarterGallery } from './gallery';

/** The gallery is now reached through Home's complete-library link, just like on desktop. */
export async function openGallery(page: Page) {
  await expect(page.locator('.dc-home, .dc-library').first()).toBeVisible();
  if (await page.locator('.dc-home').isVisible()) {
    const all = page.getByRole('button', { name: /^View all/ });
    if (await all.isVisible()) {
      await all.click();
      await page.getByRole('button', { name: 'Recently edited', exact: true }).click();
    }
  }
}

/**
 * A featured starter from the blank editor, the way someone who loaded the starters gallery adds
 * one. The gallery is served from the vendored snapshot and switched on, which takes a reload.
 */
export async function openStarter(page: Page, name: string) {
  await serveStarterGallery(page);
  await page.reload();
  await page.getByRole('button', { name: 'Quick Draft', exact: true }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.getByRole('group', { name: 'Suggested starters', exact: true }).getByRole('button', { name: `Start from ${name}`, exact: true }).click();
  await page.getByLabel('Diagram title').fill(name);
  await page.getByLabel('Diagram title').blur();
}
