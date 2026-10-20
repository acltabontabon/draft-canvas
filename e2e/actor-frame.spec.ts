import { expect, test } from '@playwright/test';
import { create, newCanvas } from './canvas';

test('new actors are borderless and their frame picker supports keyboard, undo and reload', async ({ page }) => {
  await newCanvas(page, 'Actor frames');
  await create(page, 'Actor', { x: 400, y: 300 });
  const actor = page.locator('.react-flow__node').filter({ has: page.locator('.dc-node-surface') }).first();
  await actor.click();
  const picker = page.getByRole('button', { name: /^Actor frame:/ });
  await expect(picker).toContainText('Borderless');
  const surface = actor.locator('.dc-node-surface');
  await expect(surface.locator('rect[rx="10"]')).toHaveCount(0);
  const before = await actor.boundingBox();

  await picker.click();
  await page.getByRole('option', { name: 'Framed', exact: true }).click();
  await expect(picker).toContainText('Framed');
  await expect(surface.locator('rect[rx="10"]')).toHaveCount(1);
  expect(await actor.boundingBox()).toEqual(before);

  await page.locator('.dc-canvas').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(picker).toContainText('Borderless');
  await expect(surface.locator('rect[rx="10"]')).toHaveCount(0);

  await picker.click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toContainText('Framed');
  // Reload only after the saved indicator confirms IndexedDB has the new style.
  await expect(page.locator('.dc-save')).toHaveText('Saved locally');
  await page.reload();
  await actor.click();
  await expect(picker).toContainText('Framed');
  await expect(surface.locator('rect[rx="10"]')).toHaveCount(1);
});
