import { expect, test, type Page } from '@playwright/test';
import { connectAndOpen, create, newCanvas } from './canvas';

async function choose(page: Page, name: string, option: string) {
  await expect(page.getByRole('button', { name })).toBeVisible();
  await page.getByRole('button', { name }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function contextView(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: 'Search commands' }).fill('View level');
  await expect(page.getByRole('option', { selected: true })).toContainText('View level');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('combobox', { name: 'This view shows' })).toBeVisible();
  await page.getByRole('option', { name: /^System context/ }).click();
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`assist hardening (${colorScheme})`, () => {
    test.use({ colorScheme });

    test('System Context keeps existing storage out of a system’s alternatives', async ({ page }) => {
      await newCanvas(page, 'Context assists');
      await create(page, 'Service', { x: 300, y: 250 });
      await create(page, 'Data Store', { x: 600, y: 250 });
      await page.keyboard.press('Escape');
      await page.locator('.dc-node').first().click();
      await expect(page.locator('.dc-ghost-pill')).toContainText('Connect to');

      await contextView(page);
      await expect(page.locator('.dc-ghost')).toHaveCount(0);
      await page.keyboard.press(']');
      await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'service');
      await expect(page.locator('.dc-ghost-pill-next')).toContainText('1/2');
    });

    test('read-only bucket access stays quiet, and asking still offers a notification path', async ({ page }) => {
      await newCanvas(page, 'Bucket read assists');
      await create(page, 'Service', { x: 300, y: 250 });
      await create(page, 'Data Store', { x: 600, y: 250 });
      await choose(page, 'Data Store type', 'Object Storage');
      await connectAndOpen(page, 0, 1);
      await choose(page, 'Interaction type', 'Reads');
      await page.keyboard.press('Escape');
      await page.locator('.dc-node').nth(1).click();
      await expect(page.locator('.dc-ghost')).toHaveCount(0);
      await page.keyboard.press(']');
      await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'queue');
    });

    test('changing a queue consumer into a port clears inferred dashing and undo restores it', async ({ page }) => {
      await newCanvas(page, 'Subtype connector style');
      await create(page, 'Queue', { x: 300, y: 250 });
      await create(page, 'Component', { x: 600, y: 250 });
      await connectAndOpen(page, 0, 1);
      await expect(page.locator('.dc-edge-line')).toHaveCSS('stroke-dasharray', '6px, 4px');
      await page.keyboard.press('Escape');
      await page.locator('.dc-node').nth(1).click();
      await choose(page, 'Component type', 'Port');
      await expect(page.locator('.dc-edge-line')).toHaveCSS('stroke-dasharray', 'none');
      await page.keyboard.press('ControlOrMeta+z');
      await expect(page.locator('.dc-edge-line')).toHaveCSS('stroke-dasharray', '6px, 4px');
    });
  });
}
