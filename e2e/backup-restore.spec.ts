import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { create, newCanvas } from './canvas';

/**
 * Back up the whole Library to one ZIP, then restore it into a browser that has never seen it:
 * both diagrams are listed again. A fresh context is the "cleared IndexedDB" — it starts with no
 * storage at all, exactly like a profile that lost the site's data.
 */
test('two diagrams survive Back up → fresh storage → Restore', async ({ page, browser }) => {
  // Saved before leaving each time: autosave is debounced, and the Library lists what is stored.
  await newCanvas(page, 'Orders');
  await create(page, 'Service', { x: 200, y: 200 });
  await expect(page.locator('.dc-save')).toContainText('Saved locally');
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  await newCanvas(page, 'Billing');
  await create(page, 'Data Store', { x: 200, y: 200 });
  await expect(page.locator('.dc-save')).toContainText('Saved locally');
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  await expect(page.locator('.dc-library-item-title')).toHaveText(['Billing', 'Orders']);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Back up all diagrams' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^draft-canvas-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  const path = (await file.path())!;
  const bytes = readFileSync(path);
  // A ZIP starts with the local-file-header signature "PK\x03\x04".
  expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  expect(bytes.toString('latin1')).toContain('projects.json');
  await expect(page.getByText('Backed up 2 diagrams.')).toBeVisible();

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto('/');
  // Nothing stored: the first-run screen, which has no Library list at all.
  await expect(other.locator('.dc-library-item')).toHaveCount(0);
  // The first run has no Restore button in its action row; a stored diagram brings the Library
  // back, so one is made and the backup restored beside it — never over it.
  await other.getByRole('button', { name: 'New canvas' }).click();
  await expect(other.locator('.dc-editor')).toBeVisible();
  await other.getByRole('button', { name: 'Back to your diagrams' }).click();
  await other.setInputFiles('input[aria-label="Backup file"]', path);
  await expect(other.getByText('Restored 2 diagrams.')).toBeVisible();
  await expect(other.locator('.dc-library-item-title')).toContainText(['Billing', 'Orders']);
  await expect(other.locator('.dc-library-item')).toHaveCount(3);
  await fresh.close();
});
