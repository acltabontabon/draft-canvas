import { expect, test } from '@playwright/test';

/** The open canvas lives in the address (`#doc=<id>`): a refresh, Back and a bookmark all keep it. */

test('a refresh reopens the canvas you were on, and Back returns to the Library', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const title = page.getByLabel('Diagram title');
  await title.fill('Checkout flow');
  await title.blur();
  await expect(page).toHaveURL(/#doc=/);

  await page.reload();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.getByLabel('Diagram title')).toHaveValue('Checkout flow');

  await page.goBack();
  await expect(page.locator('.dc-editor')).toHaveCount(0);
  await expect(page).not.toHaveURL(/#doc=/);

  await page.goForward();
  await expect(page.getByLabel('Diagram title')).toHaveValue('Checkout flow');
});

test('closing the canvas from inside the app clears the address', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page).toHaveURL(/#doc=/);
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  await expect(page.locator('.dc-editor')).toHaveCount(0);
  await expect(page).not.toHaveURL(/#doc=/);
});

test('an address naming a canvas this browser does not have lands on the Library, and says so', async ({ page }) => {
  await page.goto('/#doc=d_nothere00000');
  await expect(page.locator('.dc-editor')).toHaveCount(0);
  await expect(page.getByText(/isn.t in this browser/i)).toBeVisible();
  await expect(page).not.toHaveURL(/#doc=/);
});
