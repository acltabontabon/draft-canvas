import { expect, type Page } from '@playwright/test';

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

/** Starters remain in the blank editor after their previews were removed from Home. */
export async function openStarter(page: Page, name: string) {
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.getByRole('group', { name: 'Suggested starters', exact: true }).getByRole('button', { name: `Start from ${name}`, exact: true }).click();
  await page.getByLabel('Diagram title').fill(name);
  await page.getByLabel('Diagram title').blur();
}
