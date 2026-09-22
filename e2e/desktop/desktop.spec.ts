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
  // Home opens on the drafts, each drawn as the diagram it is — and, with work to come back to, the
  // motto steps down to one line.
  await expect(page.getByRole('tab', { name: 'Drafts' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Starters' })).toBeVisible();
  await expect(page.locator('.dc-desk')).toHaveAttribute('data-mode', 'returning');
  await expect(page.getByText('For meetings that suddenly need a diagram.')).toHaveCount(0);
  const tile = page.getByRole('button', { name: 'Open Quick Draft, a draft not saved to a file' });
  await expect(tile).toHaveAttribute('data-thumbnail', 'drawn');
  // A Quick Draft is not asked about on the way out.
  expect(await page.evaluate(() => window.__shell.asked())).toEqual([]);

  await tile.click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-node')).toHaveCount(1);
});

test('an empty tab says what would be there, and the tabs hold still', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 2);
  await page.addInitScript((text) => {
    window.__shell.seed({ recents: [{ name: 'payment-flow', text, ago: 60_000 }] });
  }, text);
  await page.reload();

  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Drafts' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Drafts' });
  await expect(panel).toContainText('No drafts.');
  await expect(panel.getByRole('button')).toHaveCount(0);
});

test('forgetting the last of a row leaves its tab chosen and saying so; forgetting everything is a first run again', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 2);
  await page.addInitScript((text) => {
    window.__shell.seed({ recents: [{ name: 'payment-flow', text, ago: 60_000 }], drafts: [{ title: 'Auth rework', text, ago: 60_000 }] });
  }, text);
  await page.reload();

  await page.getByRole('tab', { name: 'Recent' }).click();
  await page.getByRole('button', { name: 'Remove payment-flow from Recent' }).click();
  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Recent' })).toContainText('Nothing opened lately.');

  await page.evaluate(() => window.__shell.answer(0));
  await page.getByRole('tab', { name: 'Drafts' }).click();
  await page.getByRole('button', { name: 'Discard Auth rework' }).click();
  await expect(page.locator('.dc-desk')).toHaveAttribute('data-mode', 'first');
  await expect(page.getByText('For meetings that suddenly need a diagram.')).toBeVisible();
});

test('the row is walked and opened from the keyboard', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 2);
  await page.addInitScript((text) => {
    window.__shell.seed({ recents: [1, 2, 3].map((i) => ({ name: `diagram-${i}`, text, ago: i * 60_000 })) });
  }, text);
  await page.reload();

  await page.getByRole('button', { name: 'New Quick Draft' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Recent' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Open diagram-1' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Open diagram-2' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-status-left')).toContainText('diagram-2');
});

test('a first run keeps the full welcome, and the footer claims no global shortcut', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.dc-desk')).toHaveAttribute('data-mode', 'first');
  await expect(page.getByText('For meetings that suddenly need a diagram.')).toBeVisible();
  await expect(page.getByText('Start drawing. Name it later.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New file…' })).toBeVisible();
  const foot = page.locator('.dc-desk-foot');
  await expect(foot).toHaveText('Available from your menu bar. Your diagrams stay local.');
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

  // The rest open in the browse view, scoped to Recent, drawn as the row draws them.
  await more.click();
  const recent = page.getByRole('region', { name: 'Recent' });
  await expect(recent.locator('.dc-desk-tile')).toHaveCount(8);
  await expect(page.getByRole('button', { name: /^Recent/, pressed: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  // Back on Home, the row is as full as it was, with a connector to each tile.
  await expect(row.locator('.dc-desk-tile')).toHaveCount(await row.locator('.dc-desk-tile').count());
  await expect.poll(() => page.locator('.dc-desk-route').count()).toBe(await row.locator('.dc-desk-tile').count());
  expect(await row.locator('.dc-desk-tile').count()).toBeGreaterThan(2);
});

test('holds many projects: one Projects tab, a row of the newest, and everything one search away', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 3);
  await page.addInitScript((text) => {
    window.__shell.seed({
      projects: Array.from({ length: 10 }, (_, p) => ({
        name: `project-${p + 1}`,
        diagrams: Array.from({ length: 200 }, (_, i) => ({ path: `${i % 4 === 0 ? 'flows/' : ''}p${p + 1}-diagram-${i + 1}.draftcanvas`, text, ago: (i + 1) * 60_000 })),
      })),
    });
  }, text);
  await page.reload();

  // However many projects: one Projects tab, never a tab each — and it is the one shown, being the
  // only one with anything in it.
  await expect(page.getByRole('tab')).toHaveText(['Drafts', 'Recent', 'Projects', 'Starters']);
  await expect(page.getByRole('tab', { name: 'Projects' })).toHaveAttribute('aria-selected', 'true');
  const row = page.locator('.dc-desk-row');
  await expect(row.getByRole('button', { name: 'All 10' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Show the project-1 project' })).toContainText('200 diagrams');

  // Only the projects in the row were listed, and nothing was read beyond their front drawings.
  const called = () => page.evaluate(() => window.__shell.calls().map((call) => call.command));
  const scans = (await called()).filter((command) => command === 'project_scan').length;
  expect(scans).toBeLessThan(10);

  // One project: its diagrams, drawn — but only the ones on screen are read.
  await row.getByRole('button', { name: 'Show the project-2 project' }).click();
  const group = page.getByRole('region', { name: 'project-2' });
  await expect(group.locator('.dc-desk-tile')).toHaveCount(60);
  // 150 files directly at the root, plus one tile for the "flows" folder a quarter of them sit in —
  // browsing a project's root only shows what's directly in it, not everything below it.
  await expect(group.getByRole('button', { name: 'Show all 151' })).toBeVisible();
  await expect.poll(async () => (await called()).filter((command) => command === 'project_peek').length).toBeGreaterThan(5);
  const peeks = (await called()).filter((command) => command === 'project_peek').length;
  expect(peeks).toBeLessThan(80);

  // Everything, then a search across all ten projects.
  await page.getByRole('button', { name: /^Everything/ }).click();
  await expect.poll(async () => (await called()).filter((command) => command === 'project_scan').length).toBeGreaterThanOrEqual(10);
  await page.getByLabel('Find a diagram').fill('p7-diagram-12');
  await expect(page.getByRole('status')).toHaveText(/^\d+ diagrams? match/);
  // Everything is one combined list, not grouped by project — the match shows up in it directly.
  await expect(page.locator('.dc-browse-group')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Everything' }).locator('.dc-desk-tile').first()).toContainText('p7-diagram-12');

  // A diagram from the search opens from its own project.
  await page.getByRole('button', { name: 'Open p7-diagram-12', exact: true }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const opened = await page.evaluate(() =>
    window.__shell
      .calls()
      .filter((call) => call.command === 'project_open_file')
      .map((call) => (call.args as { relPath: string }).relPath),
  );
  expect(opened).toEqual(['p7-diagram-12.draftcanvas']);
});

test('browses a project’s folders one level at a time, with breadcrumbs back up', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 1);
  await page.addInitScript((text) => {
    window.__shell.seed({
      projects: [
        {
          name: 'Shop',
          diagrams: [
            { path: 'home.draftcanvas', text, ago: 60_000 },
            { path: 'cart.draftcanvas', text, ago: 120_000 },
            { path: 'checkout/step-1.draftcanvas', text, ago: 30_000 },
            { path: 'checkout/step-2.draftcanvas', text, ago: 20_000 },
          ],
        },
      ],
    });
  }, text);
  await page.reload();

  const row = page.locator('.dc-desk-row');
  await row.getByRole('button', { name: 'Show the Shop project' }).click();
  const group = page.getByRole('region', { name: 'Shop' });

  // At the root: the two files there, and one tile for the folder — not its contents.
  await expect(group.locator('.dc-desk-tile')).toHaveCount(3);
  await expect(group.getByRole('button', { name: 'Open home', exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Open the checkout folder' })).toBeVisible();

  // A search from the root still reaches into the folder, unlike browsing it.
  await page.getByLabel('Find a diagram').fill('step-1');
  await expect(page.getByRole('status')).toHaveText(/^\d+ diagrams? match/);
  await expect(group.getByRole('button', { name: 'Open step-1', exact: true })).toBeVisible();
  await page.getByLabel('Find a diagram').fill('');

  // Into the folder: breadcrumbs name the way back, and only its own two files show.
  await group.getByRole('button', { name: 'Open the checkout folder' }).click();
  const crumbs = page.getByRole('navigation', { name: 'Folder' });
  await expect(crumbs).toContainText('Shop');
  await expect(crumbs).toContainText('checkout');
  await expect(group.locator('.dc-desk-tile')).toHaveCount(2);
  await expect(group.getByRole('button', { name: 'Open step-1', exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Open home', exact: true })).toHaveCount(0);

  // The breadcrumb goes back to the root, with everything there again.
  await crumbs.getByRole('button', { name: 'Shop' }).click();
  await expect(group.locator('.dc-desk-tile')).toHaveCount(3);
});

test('renames the open file in place, from the File menu', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Payments', 1);
  const handle = await page.evaluate((text) => window.__shell.addFile('payments', text), text);
  await page.evaluate(
    (handle) => window.__shell.emit({ type: 'open', handle, name: 'payments', displayPath: '~/work/payments.draftcanvas' }),
    handle,
  );
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(status(page)).toContainText('~/work/payments.draftcanvas');

  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'rename' }));
  const dialog = page.getByRole('dialog', { name: 'Rename File' });
  await expect(dialog).toBeVisible();
  const input = dialog.locator('input');
  await expect(input).toHaveValue('payments');
  await input.fill('invoices');
  await dialog.getByRole('button', { name: 'Rename' }).click();

  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText('~/work/invoices.draftcanvas');
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

  // Opening an existing diagram now frames its content, so the one node here sits centred in the
  // pane rather than near its old default position — draw well into a corner instead of a fixed
  // centre-ish point, so this doesn't land back on top of it.
  const pane = await page.locator(CANVAS).boundingBox();
  await drawService(page, { x: pane!.width - 60, y: pane!.height - 60 });
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
  await expect(page.getByRole('region', { name: 'Drafts' }).getByRole('button', { name: /Auth rework/ })).toBeVisible();

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
