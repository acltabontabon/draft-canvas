import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('web saving uses local autosave and portable export/import even when native pickers exist', async ({ page }) => {
  await page.addInitScript(() => {
    const unexpectedPicker = () => { throw new Error('The web editor must not request linked-file access.'); };
    Object.defineProperty(window, 'showOpenFilePicker', { value: unexpectedPicker, configurable: true });
    Object.defineProperty(window, 'showSaveFilePicker', { value: unexpectedPicker, configurable: true });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open file…', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try an example', exact: true }).click();
  await page.getByLabel('Diagram title').fill('Portable export');
  await page.getByLabel('Diagram title').blur();
  await expect(page.locator('.dc-save')).toHaveText('Saved locally');
  await expect(page.getByRole('button', { name: 'File', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Diagram title')).toHaveValue('Portable export');
  await expect(page.locator('.dc-node')).toHaveCount(4);

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /export/i });
  await dialog.locator('[data-mode="document"]').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export document', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('portable-export.draftcanvas');
  const bytes = readFileSync((await file.path())!);
  const saved = JSON.parse(bytes.toString('utf8'));
  expect(saved.nodes).toHaveLength(4);
  expect(saved.flows).toHaveLength(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  await page.locator('input[type="file"][accept*=".draftcanvas"]').setInputFiles({ name: file.suggestedFilename(), mimeType: 'application/json', buffer: bytes });
  await expect(page.getByLabel('Diagram title')).toHaveValue('Portable export');
  await expect(page.locator('.dc-node')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'File', exact: true })).toHaveCount(0);
});
