import { expect, test } from '@playwright/test';

/**
 * The home screen as a product surface: first run's blank canvas and starters, the per-row
 * topology fingerprint, search that says how many matched, and the local-first line. Everything
 * here is checked against a fresh browser context, so each test starts from a genuinely empty
 * library.
 */

test.describe('Home screen', () => {
  test('a first run offers the starters, and one seeds a canvas that is initial state', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('group', { name: 'Starters' })).toBeVisible();
    // Nothing a first run has nothing to fill: no empty list, no search, no sidebar.
    await expect(page.getByRole('heading', { name: 'Recently edited' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Search diagrams…')).toHaveCount(0);
    await expect(page.locator('.dc-library-sidebar')).toHaveCount(0);

    await page.getByRole('button', { name: 'Start from Hexagonal' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await expect(page.locator('.dc-node')).toHaveCount(13);
    await expect(page.getByLabel('Diagram title')).toHaveValue('Hexagonal');

    // The starter is the canvas's opening state, not an edit — nothing to undo.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(13);

    await page.getByTitle('Back to your diagrams').click();
    const row = page.locator('.dc-library-item', { hasText: 'Hexagonal' });
    await expect(row).toBeVisible();
    // The fingerprint is there on return — the summary was written on create,
    // not by a later autosave — and it knows a component from a service.
    await expect(row.locator('svg.dc-fingerprint .dc-fingerprint-component').first()).toBeAttached();
    await expect(row.locator('.dc-fingerprint-boundary')).toHaveCount(1);
    await expect(page.locator('.dc-library-sidebar')).toBeVisible();
  });

  test('search counts its matches, names a miss, and clears in one click; `/` reaches it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start from Monolith' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await page.getByTitle('Back to your diagrams').click();
    await expect(page.locator('.dc-library-item', { hasText: 'Monolith' })).toBeVisible();

    await page.keyboard.press('/');
    const search = page.getByPlaceholder('Search diagrams…');
    await expect(search).toBeFocused();
    await search.fill('mono');
    await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
    await expect(page.getByText('1 of 1')).toBeVisible();

    await search.fill('zzz');
    await expect(page.getByText('No diagrams match “zzz”.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
    await expect(page.locator('.dc-library-item', { hasText: 'Monolith' })).toBeVisible();
  });

  test('first run is keyboard-first: Enter starts blank, arrows and Enter start a starter', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'New canvas' })).toBeEnabled();
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-editor')).toBeVisible();
    await expect(page.locator('.dc-node')).toHaveCount(0);

    // Back on first run only because that blank canvas is still the one thing in the library —
    // delete it to get there again.
    await page.getByTitle('Back to your diagrams').click();
    await page.getByRole('button', { name: /^Delete Untitled/ }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    // The library's own header has a same-named "New canvas" button (`LibraryScreen`) that's still
    // on screen for a moment after the delete confirms — waiting for the first-run starters group,
    // which only exists once the library has actually emptied out, is what makes the locator below
    // resolve to the sheet (`FirstRunHome`) rather than a stale reference to that header button.
    await expect(page.getByRole('group', { name: 'Starters' })).toBeVisible();
    const sheet = page.getByRole('button', { name: 'New canvas' });
    await sheet.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('button', { name: 'Start from Modular Monolith' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Diagram title')).toHaveValue('Modular Monolith');
  });

  test('the local-first line opens to the honest detail, and the toolbar fits a narrow screen', async ({ page }) => {
    await page.goto('/');
    const toggle = page.getByRole('button', { name: /Stored on this device/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(page.getByText(/Clearing this browser/)).toBeVisible();

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('button', { name: 'New canvas' })).toBeInViewport();
  });
});
