import { expect, test, type Page } from '@playwright/test';

/**
 * Projects — a lightweight, flat grouping of canvases on the homepage. See
 * `src/ui/Library/libraryFilter.ts` for the search/sort rules this exercises
 * end-to-end; the rules themselves are also unit-tested in
 * `tests/library-filter.test.ts`.
 */

async function newCanvas(page: Page, title: string) {
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const titleField = page.getByLabel('Diagram title');
  await titleField.fill(title);
  await titleField.blur();
  await expect(page.locator('.dc-save')).toContainText('Saved locally');
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
}

/** The sidebar's clickable project row itself — distinct from its hover-revealed
 *  rename/delete icon buttons, whose aria-labels also contain the project name. */
function projectNavRow(page: Page, name: string) {
  return page.locator('.dc-sidebar-project-row .dc-sidebar-row', { hasText: name });
}

async function createProject(page: Page, name: string) {
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByRole('dialog', { name: 'New project' }).getByLabel('Name').fill(name);
  await page.getByRole('dialog', { name: 'New project' }).getByRole('button', { name: 'Create' }).click();
}

async function moveToProject(page: Page, canvasTitle: string, projectName: string) {
  const row = page.locator('.dc-library-list li', { hasText: canvasTitle });
  await row.getByRole('button', { name: `Move ${canvasTitle} to a project` }).click();
  await page.getByRole('menuitemradio', { name: projectName }).click();
}

test.describe('Projects', () => {
  test('create, move, search, and delete without losing the canvas', async ({ page }) => {
    await page.goto('/');
    await newCanvas(page, 'Checkout Flow');

    /* --- Unorganized by default -------------------------------------------- */
    await page.getByRole('button', { name: 'Unorganized' }).click();
    await expect(page.locator('.dc-library-item', { hasText: 'Checkout Flow' })).toBeVisible();

    /* --- create a project and move the canvas into it ----------------------- */
    await createProject(page, 'Payments Platform');
    await expect(page.getByRole('heading', { name: 'Payments Platform' })).toBeVisible();
    await expect(page.getByText('Nothing here yet.')).toBeVisible();

    await page.getByRole('button', { name: 'Unorganized' }).click();
    await moveToProject(page, 'Checkout Flow', 'Payments Platform');

    await expect(page.locator('.dc-library-item', { hasText: 'Checkout Flow' })).toHaveCount(0);
    await projectNavRow(page, 'Payments Platform').click();
    await expect(page.locator('.dc-library-item', { hasText: 'Checkout Flow' })).toBeVisible();

    /* --- search finds it by project name, from a different view ------------ */
    await page.getByRole('button', { name: 'Unorganized' }).click();
    await page.getByPlaceholder('Search diagrams…').fill('payments platform');
    await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
    await expect(page.locator('.dc-library-item', { hasText: 'Checkout Flow' })).toBeVisible();
    await page.getByPlaceholder('Search diagrams…').fill('');

    /* --- deleting the project keeps the canvas, moves it to Unorganized ----- */
    await projectNavRow(page, 'Payments Platform').click();
    await projectNavRow(page, 'Payments Platform').hover();
    await page.getByRole('button', { name: 'Delete Payments Platform' }).click();
    await page.getByRole('dialog', { name: 'Delete this project?' }).getByRole('button', { name: 'Delete' }).click();

    await expect(projectNavRow(page, 'Payments Platform')).toHaveCount(0);
    await page.getByRole('button', { name: 'Unorganized' }).click();
    await expect(page.locator('.dc-library-item', { hasText: 'Checkout Flow' })).toBeVisible();
  });
});
