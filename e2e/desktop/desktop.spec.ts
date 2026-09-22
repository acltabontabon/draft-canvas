import { expect, test, type Page } from '@playwright/test';
import { installMockShell } from './mockShell';

/**
 * The desktop app's flow, end to end in the browser: the real editor and the real controller, with
 * the shell (Rust) faked at the IPC boundary. Files live in the fake's memory, so what these check
 * is what the app asked the shell to write and when — not the disk.
 */

const CANVAS = '.react-flow__pane';

test.beforeEach(async ({ page }) => {
  await installMockShell(page);
});

/** A `.draftcanvas` file's text, made the way the app makes one. */
async function documentText(page: Page, title: string, nodes = 0): Promise<string> {
  return page.evaluate(
    async ({ title, nodes }) => {
      const { createDocument, createNode } = await import('/src/document/factory.ts');
      const { addNodes } = await import('/src/document/operations.ts');
      const { serializeDocument } = await import('/src/export/project.ts');
      const doc = createDocument(title);
      const shapes = Array.from({ length: nodes }, (_, index) => createNode({ type: 'service', x: 100 + index * 200, y: 100 }));
      return serializeDocument(nodes > 0 ? addNodes(doc, shapes) : doc);
    },
    { title, nodes },
  );
}

async function drawService(page: Page, at = { x: 300, y: 220 }) {
  await page.getByRole('button', { name: 'Service', exact: true }).click();
  await page.locator(CANVAS).click({ position: at });
}

const status = (page: Page) => page.locator('.dc-status-left');

test('opens on its own Home, not the browser’s library', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open file…' })).toBeVisible();
  await expect(page.getByText('Nothing open.')).toBeVisible();
  // Nothing of the browser's storage-backed Library.
  await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0);
  await expect(page.getByPlaceholder('Search diagrams…')).toHaveCount(0);
});

test('a Quick Draft starts drawing at once and becomes a file on Save', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Quick Draft' }).click();

  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(status(page)).toContainText('Quick Draft');
  await expect(status(page)).toContainText('Kept on this computer until you save it');

  await drawService(page);
  await expect(page.locator('.dc-node')).toHaveCount(1);

  await page.evaluate(() => window.__shell.nextSaveAs({ name: 'meeting' }));
  await page.keyboard.press('Meta+s');

  await expect(status(page)).toContainText('Saved');
  await expect(status(page)).toContainText('~/work/meeting.draftcanvas');
  const saved = await page.evaluate(() => {
    const text = window.__shell.file('h_1')?.text ?? '';
    return { text, name: window.__shell.file('h_1')?.name };
  });
  expect(saved.name).toBe('meeting');
  const parsed = JSON.parse(saved.text) as { format: string; nodes: unknown[] };
  expect(parsed.format).toBe('draft-canvas');
  expect(parsed.nodes).toHaveLength(1);
});

test('what is unsaved is kept, and offered back from Home', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Quick Draft' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await drawService(page);

  // The snapshot follows a short quiet spell, so it is written by the time the user has moved on.
  await expect.poll(() => page.evaluate(() => window.__shell.recoveryIds().length)).toBe(1);

  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  await expect(page.getByRole('heading', { name: 'Unsaved' })).toBeVisible();
  // A Quick Draft is not asked about on the way out.
  expect(await page.evaluate(() => window.__shell.asked())).toEqual([]);

  await page.locator('.dc-library-item', { hasText: 'Quick Draft' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-node')).toHaveCount(1);
});

test('opens a file, says when it has unsaved changes, and asks before leaving it', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Payments', 1);
  await page.evaluate((text) => {
    const handle = window.__shell.addFile('payments', text);
    window.__shell.nextOpen(handle);
  }, text);

  await page.getByRole('button', { name: 'Open file…' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-node')).toHaveCount(1);
  await expect(status(page)).toContainText('Saved');
  await expect(status(page)).toContainText('~/work/payments.draftcanvas');

  await drawService(page, { x: 600, y: 300 });
  await expect(status(page)).toContainText('Unsaved changes');

  // Cancel: stay, with the changes still there.
  await page.evaluate(() => window.__shell.answer(2));
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(status(page)).toContainText('Unsaved changes');
  const question = await page.evaluate(() => window.__shell.asked());
  expect(question[0]!.buttons).toEqual(['Save', 'Don’t Save', 'Cancel']);

  // Save: leaves with the file written.
  await page.evaluate(() => window.__shell.answer(0));
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(window.__shell.file('h_1')!.text).nodes.length);
  expect(saved).toBe(2);
});

test('the native menu saves, and a file the OS opens replaces Home', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Checkout', 0);
  const handle = await page.evaluate((text) => window.__shell.addFile('checkout', text), text);

  await page.evaluate((handle) => window.__shell.emit({ type: 'open', handle, name: 'checkout', displayPath: '~/work/checkout.draftcanvas' }), handle);
  await expect(page.locator('.dc-editor')).toBeVisible();

  await drawService(page);
  await expect(status(page)).toContainText('Unsaved changes');

  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'save' }));
  await expect(status(page)).toContainText('Saved');
  const saved = await page.evaluate((handle) => JSON.parse(window.__shell.file(handle)!.text).nodes.length, handle);
  expect(saved).toBe(1);
});

test('exports go through the shell’s Save dialog, and cancelling one is not a failure', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Quick Draft' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await drawService(page);

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog).toBeVisible();
  // A first-ever Export opens on Image; the document is what carries the diagram itself.
  await dialog.locator('[data-mode="document"]').click();
  await page.getByRole('button', { name: 'Export document' }).click();

  await expect.poll(() => page.evaluate(() => window.__shell.exports().length)).toBe(1);
  const [exported] = await page.evaluate(() => window.__shell.exports());
  expect(exported!.name).toBe('quick-draft.draftcanvas');
  const file = JSON.parse(exported!.text) as { format: string; nodes: unknown[] };
  expect(file.format).toBe('draft-canvas');
  expect(file.nodes).toHaveLength(1);
  // Saving a copy is not Save As: the Quick Draft is still a draft.
  await expect(page.locator('.dc-status-left')).toContainText('Quick Draft');
});

test('cancelling an export’s Save dialog leaves the export dialog as it was, without an error', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Quick Draft' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.evaluate(() => window.__shell.cancelNextExport());

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.locator('[data-mode="document"]').click();
  await page.getByRole('button', { name: 'Export document' }).click();

  await expect.poll(() => page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'export_file').length)).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(page.getByText(/export failed/i)).toHaveCount(0);
});

test('the native Edit menu undoes what was drawn', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Quick Draft' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await drawService(page);
  await expect(page.locator('.dc-node')).toHaveCount(1);

  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'undo' }));
  await expect(page.locator('.dc-node')).toHaveCount(0);

  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'redo' }));
  await expect(page.locator('.dc-node')).toHaveCount(1);
});

test('a file that is not a diagram is refused without leaving Home', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const handle = window.__shell.addFile('notes', '{ definitely not a diagram');
    window.__shell.nextOpen(handle);
  });

  await page.getByRole('button', { name: 'Open file…' }).click();

  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  await expect(page.locator('.dc-editor')).toHaveCount(0);
  const calls = await page.evaluate(() => window.__shell.calls().map((call) => call.command));
  expect(calls).toContain('show_error');
});
