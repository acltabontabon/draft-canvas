import type { Page } from '@playwright/test';

/** Select a seeded ~/work file through the same explorer a person opens from Home. */
export async function chooseWorkFile(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: 'Open a diagram', exact: true });
  await dialog.getByRole('option', { name: 'work', exact: true }).dblclick();
  await dialog.getByRole('option', { name: `${name}.draftcanvas`, exact: true }).click();
  await dialog.getByRole('button', { name: 'Open diagram', exact: true }).click();
}
