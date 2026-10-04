import { expect, test } from '@playwright/test';
import { installMockShell } from './mockShell';

test('the complete example is a desktop Quick Draft with an editable flow', async ({ page }) => {
  await installMockShell(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Try an example', exact: true }).click();
  await expect(page.locator('.dc-node')).toHaveCount(4);
  await expect(page.locator('.dc-status-left')).toContainText('Quick Draft');
  await page.getByRole('button', { name: 'Play explanation', exact: true }).click();
  await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'edit');
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page.getByRole('button', { name: 'Trace a flow', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Trace a flow' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Trace a flow' })).toHaveCount(0);
});
