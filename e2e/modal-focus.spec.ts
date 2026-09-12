import { expect, test, type Page } from '@playwright/test';

/**
 * Focus behavior shared by every dialog built on `Modal` (Keyboard Shortcuts, Export, Canvas
 * Settings, About) — Tab-trapped while open, focus handed back to whatever opened it on close.
 * Exercised once here against the Keyboard Shortcuts sheet rather than duplicated per dialog,
 * since all of them share the exact same `Modal` implementation.
 */

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

async function openShortcutSheet(page: Page) {
  await page.getByRole('button', { name: /^More/ }).click();
  await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
}

test.describe('Modal focus behavior', () => {
  test('closing the keyboard shortcuts sheet returns focus to whatever opened it', async ({ page }) => {
    await newCanvas(page, 'Modal focus return');
    const trigger = page.getByRole('button', { name: /^More/ });
    await openShortcutSheet(page);
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
    // The sheet now opens from the overflow menu, so "whatever opened it" is that trigger.
    await expect(trigger).toBeFocused();
  });

  test('Tab cycles within the sheet instead of escaping to the page behind it', async ({ page }) => {
    await newCanvas(page, 'Modal tab trap');
    await openShortcutSheet(page);
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();

    // The sheet's own search input wins initial focus via `autoFocus` (React applies that
    // synchronously during commit, before `Modal.tsx`'s own mount-effect `panel.focus()` gets a
    // turn) — Shift+Tab from there lands on the header's Close button, still inside the dialog;
    // confirms the trap keeps focus contained regardless of which control starts with it.
    await page.keyboard.press('Shift+Tab');
    const active = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]');
      return dialog?.contains(document.activeElement) ?? false;
    });
    expect(active).toBe(true);
  });

  test('shows the previously-undocumented shortcuts, and the filter narrows the list', async ({ page }) => {
    await newCanvas(page, 'Modal shortcuts content');
    await openShortcutSheet(page);
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();

    // Confirmed drifted/missing from the old hand-maintained list — now generated from the
    // registry via `shortcutLookup.ts`, so they can't go missing again without a failing test.
    await expect(dialog).toContainText('Group into boundary');
    await expect(dialog).toContainText('Ungroup');
    await expect(dialog).toContainText('Open the selected element');
    await expect(dialog).toContainText('Accept the suggested next element');
    await expect(dialog).toContainText('Select the nearest element in that direction');

    await page.getByRole('searchbox', { name: 'Filter shortcuts' }).fill('zoom');
    await expect(dialog).toContainText('Zoom in');
    await expect(dialog).toContainText('Zoom out');
    await expect(dialog).not.toContainText('Undo');
    await expect(dialog).not.toContainText('Group into boundary');
  });
});
