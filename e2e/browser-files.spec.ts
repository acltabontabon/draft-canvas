import { expect, test } from '@playwright/test';

// An injectable file capability exercises the UI, IDB associations and native writable streams.
// Actual OS pickers and persisted permissions remain a separate manual acceptance check.
test('file saving retains recovery across reload and detects an outside write', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native file access is a Chromium capability.');
  await page.addInitScript(() => {
    // This browser build crashes when structured-cloning an OPFS capability into IndexedDB.
    // Keep the chooser/handle transport injectable, while exercising real streams and recovery.
    const wrap = (name: string) => ({
      name,
      getFile: async () => (await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true })).getFile(),
      createWritable: async () => (await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true })).createWritable(),
      queryPermission: async () => 'granted', requestPermission: async () => 'granted',
      isSameEntry: async (other: { name: string }) => other.name === name,
    });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      return put.call(this, this.name === 'fileAssociations' ? { ...value, handle: { name: value.handle.name } } : value, key);
    };
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function(...args) {
      const request = getAll.apply(this, args);
      if (this.name === 'fileAssociations') {
        request.addEventListener('success', () => {
          const rows = request.result.map(row => ({ ...row, handle: wrap(row.handle.name) }));
          Object.defineProperty(request, 'result', { value: rows });
        });
      }
      return request;
    };
    Object.defineProperty(window, 'showSaveFilePicker', { value: async () => wrap('journey.draftcanvas'), configurable: true });
    Object.defineProperty(window, 'showOpenFilePicker', { value: async () => [wrap('journey.draftcanvas')], configurable: true });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try an example', exact: true }).click();
  await expect(page.getByLabel('Diagram title')).toHaveValue('Order processing');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save', exact: true }).click();
  await expect(page.locator('.dc-status')).toContainText('Saved to journey.draftcanvas');
  const disk = await page.evaluate(async () => JSON.parse(await (await (await navigator.storage.getDirectory()).getFileHandle('journey.draftcanvas')).getFile().then(f => f.text())));
  expect(disk.flows).toHaveLength(1);
  await page.locator('.dc-node').first().dblclick();
  await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Order intake API');
  await page.getByRole('textbox', { name: 'Label', exact: true }).press('ControlOrMeta+s');
  await expect.poll(() => page.evaluate(async () => JSON.parse(await (await (await navigator.storage.getDirectory()).getFileHandle('journey.draftcanvas')).getFile().then(f => f.text())).nodes[0].text)).toBe('Order intake API');
  await page.getByLabel('Diagram title').fill('Recovered order');
  await page.getByLabel('Diagram title').press('Enter');
  await expect(page.locator('.dc-status')).toContainText('Changes recovered in this browser');
  await page.reload();
  await expect(page.getByLabel('Diagram title')).toHaveValue('Recovered order');
  await expect(page.locator('.dc-status')).toContainText('Changes recovered in this browser');
  await page.evaluate(async () => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('journey.draftcanvas');
    const doc = JSON.parse(await (await handle.getFile()).text());
    doc.metadata.title = 'Outside version';
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify(doc));
    await writer.close();
  });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save', exact: true }).click();
  const question = page.getByRole('dialog', { name: 'File changed on disk' });
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Diagram title')).toHaveValue('Recovered order');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save', exact: true }).click();
  await question.getByRole('button', { name: 'Overwrite', exact: true }).click();
  await expect(page.locator('.dc-status')).toContainText('Saved to journey.draftcanvas');
});

test('unsupported browsers keep Import and Export without file controls', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open file…', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try an example', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'File', exact: true })).toHaveCount(0);
});
