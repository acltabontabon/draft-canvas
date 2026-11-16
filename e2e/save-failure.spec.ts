import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas } from './canvas';

/**
 * The browser refuses every write — a full disk, as far as the page can tell. Instead of a message
 * and nothing to do about it, the status bar says why and offers Retry, Export and Leave without
 * saving. The failure is made in the page (`IDBObjectStore.put` throws a quota error while a flag is
 * set), so everything above storage is the real thing.
 */
async function failWrites(page: Page, on: boolean) {
  await page.evaluate((value) => {
    (window as unknown as { __diskFull: boolean }).__diskFull = value;
  }, on);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      if ((window as unknown as { __diskFull?: boolean }).__diskFull) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
});

test('a failed save names its reason, exports what is on screen, retries, and leaves when asked', async ({ page }) => {
  await newCanvas(page, 'Disk full');
  await expect(page.locator('.dc-save')).toContainText('Saved locally');

  await failWrites(page, true);
  await create(page, 'Service', { x: 400, y: 300 });
  const bar = page.locator('.dc-status');
  await expect(bar.locator('.dc-save')).toHaveText('Storage full — not saved', { timeout: 10_000 });
  await expect(bar).toContainText('Export it, then free space by deleting diagrams in the Library');

  // Export: the diagram as it is on screen, the shape that could not be stored included.
  const download = page.waitForEvent('download');
  await bar.getByRole('button', { name: 'Export' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('disk-full.draftcanvas');
  const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
  expect(JSON.parse(text).nodes).toHaveLength(1);

  // Retry while it still fails: still said, no dead end.
  await bar.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.dc-toast-message').filter({ hasText: 'Still couldn’t save' })).toBeVisible();
  await expect(bar.locator('.dc-save')).toHaveText('Storage full — not saved');

  // Space freed: Retry saves it.
  await failWrites(page, false);
  await bar.getByRole('button', { name: 'Retry' }).click();
  await expect(bar.locator('.dc-save')).toContainText('Saved locally');
  await expect(bar.getByRole('button', { name: 'Leave without saving' })).toHaveCount(0);

  // Another failed edit, then Leave without saving: asked first, and the diagram returns to what was stored.
  await failWrites(page, true);
  await create(page, 'Service', { x: 700, y: 300 });
  await expect(bar.locator('.dc-save')).toHaveText('Storage full — not saved', { timeout: 10_000 });
  await bar.getByRole('button', { name: 'Leave without saving' }).click();
  await expect(bar).toContainText('Changes since the last save will be lost.');
  await bar.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await bar.getByRole('button', { name: 'Leave without saving' }).click();
  await bar.getByRole('button', { name: 'Discard and leave' }).click();
  await expect(page.locator('.dc-editor')).toHaveCount(0);

  await failWrites(page, false);
  await page.reload();
  await page.getByRole('button', { name: 'Open Disk full', exact: true }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  // One shape: the second one was given up.
  await expect(page.locator('.react-flow__node').filter({ has: page.locator('.dc-node-surface') })).toHaveCount(1);
});
