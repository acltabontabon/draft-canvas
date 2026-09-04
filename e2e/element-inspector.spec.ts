import { expect, test, type Page } from '@playwright/test';

/** Contextual popover for a single selected element, anchored at the element instead of docked
 *  at the bottom of the screen — mirrors `connector-semantics.spec.ts`'s coverage of the
 *  equivalent connector popover. */

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

async function create(page: Page, tool: string, at: { x: number; y: number }) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: at });
}

test.describe('element inspector popover', () => {
  test('selecting one element shows its popover near it, not the bottom bar', async ({ page }) => {
    await newCanvas(page, 'Element popover basics');
    await create(page, 'Service', { x: 400, y: 300 });

    await page.locator('.dc-node').first().click();

    await expect(page.locator('.dc-element-inspector')).toBeVisible();
    await expect(page.locator('.dc-inspector')).toHaveCount(0);

    // Colour: opens the palette and applies a swatch, which the compact row's own swatch then
    // reflects.
    const swatch = page.getByRole('button', { name: 'Element colour' });
    const before = await swatch.getAttribute('style');
    await swatch.click();
    await page.getByRole('button', { name: 'Colour rose' }).click();
    await expect(swatch).not.toHaveAttribute('style', before ?? '');

    // Type: Service's kind dropdown changes the node's badge.
    await page.getByRole('button', { name: 'Service type' }).click();
    await page.getByRole('option', { name: 'External' }).click();
    await expect(page.locator('.dc-node').first()).toContainText('EXTERNAL');

    // Regression: switching to a short value (e.g. "API") must not shrink the *menu* down to
    // that value's width — reopening it should still show every option at full width, not
    // clipped to "G..."/"W..." by an inherited, too-narrow trigger box.
    await page.getByRole('button', { name: 'Service type' }).click();
    await page.getByRole('option', { name: 'API' }).click();
    await page.getByRole('button', { name: 'Service type' }).click();
    for (const option of await page.getByRole('option').all()) {
      await expect
        .poll(() => option.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
        .toBe(true);
    }
    await expect(page.getByRole('option', { name: 'External' })).toBeVisible();
    await page.getByRole('option', { name: 'External' }).click();
    await expect(page.locator('.dc-node').first()).toContainText('EXTERNAL');

    // Focus.
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    await expect(page.locator('.dc-canvas[data-focus="on"]')).toBeVisible();
    await page.keyboard.press('Escape');

    // Delete is directly in the row — no "More options" step.
    await page.getByRole('button', { name: 'Delete selection' }).click();
    await expect(page.locator('.dc-node')).toHaveCount(0);
  });

  test('selecting two elements still shows the shared bottom bar, not the popover', async ({ page }) => {
    await newCanvas(page, 'Element popover multi-select');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Data Store', { x: 600, y: 300 });

    await page.locator('.dc-node').first().click();
    await expect(page.locator('.dc-element-inspector')).toBeVisible();

    await page.locator('.dc-node').nth(1).click({ modifiers: ['Shift'] });

    await expect(page.locator('.dc-inspector')).toContainText('2 elements');
    await expect(page.locator('.dc-element-inspector')).toHaveCount(0);
  });
});
