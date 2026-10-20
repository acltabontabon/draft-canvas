import { expect, test } from '@playwright/test';
import { openGallery, openStarter } from './library';

/** The shared Home composition, browser projects and the full Canvas Gallery. */
test.describe('Home screen', () => {
  test('an empty Home keeps its separator and invitation, with no starters, tabs, or search', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.locator('.dc-home')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(page.locator('.dc-living-primary')).toHaveCSS('background-color', 'rgb(13, 110, 101)');
    await expect(page.locator('.dc-living-primary')).toHaveCSS('color', 'rgb(255, 255, 255)');
    await expect(page.getByRole('heading', { name: 'It starts with a thought.' })).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Starters' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Find a diagram' })).toHaveCount(0);
    await expect(page.locator('.dc-home-shelf-head')).toHaveCSS('border-bottom-width', '1px');
    await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeVisible();
  });

  test('a browser project can be created before any diagrams, and its single view has no tab or search', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New canvas' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('button', { name: 'New project' })).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'New project', exact: true });
    await dialog.getByLabel('Name').fill('Architecture');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Show the Architecture project' })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Find a diagram' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show the Architecture project' }).click();
    await expect(page.getByRole('heading', { name: 'Architecture', exact: true })).toBeVisible();
    await expect(page.getByRole('searchbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.locator('.dc-living')).toBeVisible();
  });

  test('the first example brings back views and search; shelf and gallery navigation work by keyboard', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Try an example' }).click();
    await expect(page.locator('.dc-node')).toHaveCount(4);
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await expect(page.getByRole('tab')).toHaveText(['Drafts', 'Recent', 'Projects']);
    await expect(page.getByRole('button', { name: 'Find a diagram' })).toBeVisible();
    await page.getByRole('button', { name: 'New canvas' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('tab', { name: 'Drafts' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Recent' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('button', { name: 'Open Order processing' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-editor')).toBeVisible();
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await openGallery(page);
    await expect(page.locator('.dc-gallery-card')).toHaveCount(1);
    await page.locator('.dc-gallery-open').click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await expect(page.locator('.dc-library')).toBeVisible();
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.locator('.dc-living')).toBeVisible();
  });

  test('search from Home opens the full gallery, searches, clears a miss, and Escape returns Home', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await page.getByRole('button', { name: 'Find a diagram' }).click();
    const search = page.getByPlaceholder('Search diagrams…');
    await expect(search).toBeFocused();
    await search.fill('order');
    await expect(page.getByText('1 of 1')).toBeVisible();
    await search.fill('zzz');
    await expect(page.getByText('No diagrams match “zzz”.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-living')).toBeVisible();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(page.getByPlaceholder('Search diagrams…')).toBeFocused();
  });

  test('the gallery reflows real previews and keeps backup details compact in both themes', async ({ page }) => {
    await page.goto('/');
    await openStarter(page, 'Monolith');
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await openGallery(page);
    for (let index = 0; index < 3; index++) {
      await page.getByRole('button', { name: 'Duplicate Monolith', exact: true }).click();
      await expect(page.locator('.dc-gallery-card')).toHaveCount(index + 2);
    }
    for (const theme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator(':root')).toHaveAttribute('data-theme', theme);
      for (const [width, columns] of [[1200, 3], [760, 2], [375, 1]]) {
        await page.setViewportSize({ width, height: 900 });
        await expect.poll(() => page.locator('.dc-gallery-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(columns);
        await expect.poll(() => page.locator('.dc-gallery-grid').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
    }
    await expect(page.getByText('No recent backup')).toBeVisible();
    await expect(page.getByText(/Your last backup is missing/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Stored on this device Details' }).click();
    await expect(page.getByText(/Your last backup is missing/)).toBeVisible();
  });

  test('deleting the last draft returns to an empty Home without search or tabs', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New canvas' }).click();
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await openGallery(page);
    await page.getByRole('button', { name: /^Delete Untitled/ }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('.dc-living')).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Find a diagram' })).toHaveCount(0);
    await expect(page.locator('.dc-home-shelf-head')).toBeVisible();
  });
});
