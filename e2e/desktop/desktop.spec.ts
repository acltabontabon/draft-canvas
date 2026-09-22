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
  // With nothing opened yet, the fan points only at starters, and its label says so.
  await expect(page.getByText('or cheat a little')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start from Microservices' })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
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
  // Home opens on what isn't saved, drawn as the diagram it is.
  await expect(page.getByRole('tab', { name: 'Unsaved' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Starters' })).toBeVisible();
  const tile = page.getByRole('button', { name: 'Recover Quick Draft' });
  await expect(tile).toHaveAttribute('data-thumbnail', 'drawn');
  // A Quick Draft is not asked about on the way out.
  expect(await page.evaluate(() => window.__shell.asked())).toEqual([]);

  await tile.click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-node')).toHaveCount(1);
});

test('recent files are drawn from their own contents, without being opened', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Payments', 3);
  await page.evaluate((text) => {
    const handle = window.__shell.addFile('payments', text);
    window.__shell.nextOpen(handle);
  }, text);
  await page.getByRole('button', { name: 'Open file…' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();

  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  const tile = page.getByRole('button', { name: 'Open payments' });
  await expect(tile).toHaveAttribute('data-thumbnail', 'drawn');
  // Three services on the canvas, three marks on the tile.
  await expect(tile.locator('.dc-fingerprint-service')).toHaveCount(3);
  // Drawing it was a look, not an open: nothing but the one real open reached the shell.
  const opens = await page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'open_dialog' || call.command === 'open_handle').length);
  expect(opens).toBe(1);

  // A starter makes a Quick Draft already holding it.
  await page.getByRole('tab', { name: 'Starters' }).click();
  await page.getByRole('button', { name: 'Start from Microservices' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-status-left')).toContainText('Quick Draft');
  expect(await page.locator('.dc-node').count()).toBeGreaterThan(3);
});

test('draws the tray menu: the actions, and each file and draft as its own diagram', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 3);
  await page.addInitScript((text) => {
    window.__shell.seed({
      recents: [{ name: 'payment-flow', text, ago: 60_000 }],
      drafts: [{ title: 'Auth rework', text, ago: 60_000 }],
    });
  }, text);
  await page.reload();

  type Art = { actions: Record<string, string>; files: { handle: string; png: string }[]; drafts: { id: string; title: string; png?: string }[] };
  await expect.poll(() => page.evaluate(() => (window.__shell.trayArt() as Art | null)?.files.length ?? 0)).toBe(1);
  const art = (await page.evaluate(() => window.__shell.trayArt())) as Art;
  expect(Object.keys(art.actions).sort()).toEqual(['newCanvas', 'open', 'openProject', 'quickDraft']);
  expect(art.drafts).toEqual([expect.objectContaining({ title: 'Auth rework', png: expect.any(String) })]);
  // Real PNGs, and by handle: nothing in what the page sends names a path.
  for (const image of [...Object.values(art.actions), art.files[0]!.png, art.drafts[0]!.png!]) {
    expect(Buffer.from(image, 'base64').subarray(1, 4).toString()).toBe('PNG');
  }
  expect(JSON.stringify(art)).not.toContain('/work/');
});

test('keeps the row to one line, with the rest one click away', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 2);
  await page.addInitScript((text) => {
    window.__shell.seed({ recents: Array.from({ length: 8 }, (_, i) => ({ name: `diagram-${i + 1}`, text, ago: (i + 1) * 60_000 })) });
  }, text);
  await page.reload();

  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  const row = page.locator('.dc-desk-row');
  const more = row.getByRole('button', { name: 'All 8' });
  await expect(more).toBeVisible();
  // Every tile in one row: nothing wraps under the connectors.
  const tops = await row.locator('.dc-desk-tile').evaluateAll((tiles) => new Set(tiles.map((tile) => (tile as HTMLElement).offsetTop)).size);
  expect(tops).toBe(1);

  await more.click();
  await expect(page.locator('.dc-desk-all li')).toHaveCount(8);
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

test('an update is offered quietly, and nothing happens to it until it is asked for', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  await expect(page.locator('.dc-update-chip')).toHaveCount(0);

  const info = { version: '1.10.0', notes: '### Added\n- Draft Canvas keeps itself **up to date**.' };
  await page.evaluate(
    (info) => window.__shell.setUpdate({ currentVersion: '1.9.4', state: { phase: 'available', info }, dismissed: false, held: null, error: null }),
    info,
  );
  const chip = page.getByRole('button', { name: 'Update available · 1.10.0' });
  await expect(chip).toBeVisible();
  const called = () => page.evaluate(() => window.__shell.calls().map((call) => call.command));
  expect(await called()).not.toContain('update_download');

  await chip.click();
  const dialog = page.getByRole('dialog', { name: 'A new version of Draft Canvas' });
  await expect(dialog.getByText('up to date')).toBeVisible();
  await expect(dialog.getByLabel('From version 1.9.4 to version 1.10.0')).toBeVisible();
  await dialog.getByRole('button', { name: 'Download' }).click();
  await expect.poll(called).toContain('update_download');
  expect(await called()).not.toContain('update_install');

  await page.evaluate(
    (info) => window.__shell.setUpdate({ currentVersion: '1.9.4', state: { phase: 'ready', info }, dismissed: false, held: null, error: null }),
    info,
  );
  await expect(page.getByRole('button', { name: 'Restart to update' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Update and restart' }).click();
  await expect.poll(called).toContain('update_install');
});

test('Settings has the update switch, and turning it off tells the shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'settings' }));
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const auto = settings.getByRole('checkbox', { name: /Check for updates automatically/ });
  await expect(auto).toBeChecked();
  await auto.uncheck();
  await expect(auto).not.toBeChecked();
  const patches = await page.evaluate(() =>
    window.__shell
      .calls()
      .filter((call) => call.command === 'settings_set')
      .map((call) => (call.args as { patch: unknown }).patch),
  );
  expect(patches).toContainEqual({ autoCheckUpdates: false });
  await expect(settings.getByRole('button', { name: 'Check for updates' })).toBeVisible();
});

test('the tray panel draws each diagram and chooses only through the shell', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Payments', 3);
  await page.addInitScript((text) => {
    window.__shell.seed({
      recents: [
        { name: 'payment-flow', text, ago: 60_000 },
        { name: 'checkout', text, ago: 120_000 },
      ],
      drafts: [{ title: 'Auth rework', text, ago: 60_000 }],
    });
  }, text);
  await page.goto('/tray.html');

  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const recent = page.getByRole('region', { name: 'Recent' });
  await expect(recent.getByRole('button')).toHaveCount(2);
  // Each file is drawn as itself, read by its handle.
  await expect(recent.locator('.dc-tray-thumb[data-state="drawn"]')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Unsaved' }).getByRole('button', { name: /Auth rework/ })).toBeVisible();

  const chosen = () =>
    page.evaluate(() =>
      window.__shell
        .calls()
        .filter((call) => call.command === 'tray_choose')
        .map((call) => (call.args as { choice: string }).choice),
    );
  await recent.getByRole('button', { name: /payment-flow/ }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open…' }).click();
  expect(await chosen()).toEqual(['recent:h_1', 'panel:dismiss', 'tray:open']);

  // It told the shell how tall it came out, and never asked for anything a panel shouldn't.
  const commands = await page.evaluate(() => [...new Set(window.__shell.calls().map((call) => call.command))].sort());
  expect(commands).toEqual(['peek_document', 'recovery_read', 'tray_choose', 'tray_panel', 'tray_panel_fit']);
});
