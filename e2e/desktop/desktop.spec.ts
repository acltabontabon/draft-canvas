import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { desktopNotes } from '../../scripts/update-manifest.mjs';
import { installMockShell } from './mockShell';
import { chooseWorkFile } from './explorer';

/**
 * The desktop app's flow, end to end in the browser: the real editor and the real controller, with
 * the shell (Rust) faked at the IPC boundary. Files live in the fake's memory, so what these check
 * is what the app asked the shell to write and when — not the disk.
 */

const CANVAS = '.react-flow__pane';
// The inked inline-block can separate the final period in the heading's accessible name.
const HOME_HEADLINE = /^It starts with a thought\s*\.$/;

test.beforeEach(async ({ page }) => {
  await installMockShell(page);
});

/**
 * The reload that lets a test's seed (an init script) reach the faked shell. The app warms the editor
 * chunk once the page is idle (`App.tsx`), and a reload landing mid-import made WebKit report it as
 * "Importing a module script failed" (a page error some tests count as a crash) or fail the reload
 * itself with "WebKit encountered an internal error". Importing the same module here waits for that
 * graph — a module loads once — so the warm-up has nothing left to fetch, whenever it fires.
 * The desktop shell also renders Home, Settings and AgentActivity as lazy chunks at start-up; a
 * reload that cut Home or Settings off mid-import failed the same way (6 runs in 15), so this waits
 * for every chunk `App.tsx` loads before anyone asks.
 */
async function reloadSeeded(page: Page) {
  await page.evaluate(() =>
    Promise.all([
      import('/src/ui/Editor/EditorScreen.tsx'),
      import('/src/desktop/ui/DesktopHome.tsx'),
      import('/src/desktop/ui/settings/SettingsDialog.tsx'),
      import('/src/desktop/ui/AgentActivity.tsx'),
    ]).then(() => undefined),
  );
  await page.reload();
}

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
  // A first run offers Projects; empty history tabs stay out of the way.
  await expect(page.getByRole('group', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Drafts' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Starters' })).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Find a diagram', exact: true })).toHaveCount(0);
  // Nothing of the browser's storage-backed Library.
  await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0);
  await expect(page.getByPlaceholder('Search diagrams…')).toHaveCount(0);
});

test('desktop sharing creates a protected public editor link and supports manual copying', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied'); } } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'New Quick Draft' }).click();
  await drawService(page);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Share read-only link/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export & share' });
  await dialog.getByText('Share', { exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /Require a passphrase/ })).toBeChecked();
  await dialog.getByLabel('Passphrase', { exact: true }).fill('copper river orbit lantern');
  await dialog.getByLabel('Confirm passphrase').fill('copper river orbit lantern');
  await dialog.getByRole('button', { name: 'Copy protected link' }).click();
  const manual = dialog.getByRole('textbox', { name: 'Share link', exact: true });
  await expect(manual).toBeVisible();
  await expect(dialog.getByText(/The clipboard is unavailable/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Copy link', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('link', { name: 'Open Guided reader' })).toHaveAttribute('href', await manual.inputValue());
  const link = new URL(await manual.inputValue());
  expect(link.origin).toBe('https://app.draftcanvas.dev');
  expect(link.pathname).toBe('/');
  expect(link.hash).toMatch(/^#d=2\./);
  expect(link.href).not.toContain('copper');
});

test('Projects browses folders in-app, cancels without linking, and adds the selected folder', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Overview', 2);
  await page.evaluate((text) => window.__shell.seed({ explorer: [{ name: 'Architecture', path: '~/Documents/Architecture', diagrams: [{ path: 'overview.draftcanvas', text, ago: 1000 }] }] }), text);
  await page.getByRole('button', { name: 'New Quick Draft' }).focus();
  await page.keyboard.press('ArrowDown');
  const panel = page.getByRole('group', { name: 'Projects', exact: true });
  await expect(panel.getByRole('button', { name: 'Add project…' })).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add a project', exact: true });
  await expect(dialog.getByRole('listbox', { name: 'Folders and diagrams' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('option', { name: 'Architecture' }).dblclick();
  await expect(dialog.getByRole('option', { name: 'overview.draftcanvas' })).toBeVisible();
  await dialog.getByRole('option', { name: 'overview.draftcanvas' }).click();
  await expect(dialog.getByRole('complementary', { name: 'Selection preview' }).locator('.dc-explorer-paper svg')).toBeVisible();
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'explorer_add_project').length)).toBe(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toContainText('A home for related ideas.');
  await expect(panel.getByRole('button', { name: 'Add project…' })).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.__shell.calls().filter(call => call.command === 'explorer_close').length)).toBeGreaterThan(0);

  await page.keyboard.press('Enter');
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('option', { name: 'Architecture' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('option', { name: 'overview.draftcanvas' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.getByRole('button', { name: 'Show the Architecture project' })).toBeVisible();
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'pick_project').length)).toBe(0);
  await panel.getByRole('button', { name: 'Show the Architecture project' }).click();
  await expect(page.getByRole('region', { name: 'Architecture', exact: true })).toBeVisible();
});

test('explorer filters and pages folders, navigates history, and recovers from unreadable locations', async ({ page }) => {
  await page.goto('/');
  // The menu event below is dropped if it beats host_ready; Home renders after that handshake.
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const text = await documentText(page, 'Topology', 3);
  await page.evaluate((text) => window.__shell.seed({ explorer: [
    { name: 'Studio', path: '~/Documents/Studio', diagrams: [
      { path: 'flow.draftcanvas', text, ago: 1000 },
      { path: '.private/hidden.draftcanvas', text, ago: 1000 },
      { path: 'subfolder/detail.draftcanvas', text, ago: 1000 },
    ] },
    ...Array.from({ length: 205 }, (_, i) => ({ name: `Folder ${i}`, path: `~/Downloads/Folder ${String(i).padStart(3, '0')}`, diagrams: [] })),
  ] }), text);
  // The native File menu uses the same explorer as Home.
  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'open-project' }));
  const dialog = page.getByRole('dialog', { name: 'Add a project', exact: true });
  const places = dialog.getByRole('complementary', { name: 'Places' });
  await places.getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('option', { name: 'Studio' }).dblclick();
  await expect(dialog.getByRole('option', { name: '.private' })).toHaveCount(0);
  await dialog.getByRole('checkbox', { name: 'Hidden' }).check();
  await expect(dialog.getByRole('option', { name: '.private' })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Find in this folder' }).fill('FLOW');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('option', { name: 'flow.draftcanvas' })).toBeVisible();
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'explorer_peek').length)).toBe(0);
  await dialog.getByRole('option', { name: 'flow.draftcanvas' }).click();
  await expect(dialog.getByRole('complementary', { name: 'Selection preview' }).locator('.dc-explorer-paper svg')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__shell.calls().filter(call => call.command === 'explorer_peek').length)).toBe(1);
  await dialog.getByRole('textbox', { name: 'Find in this folder' }).fill('unmatched');
  await expect(dialog).toContainText('No matches in this folder');
  await dialog.getByRole('textbox', { name: 'Find in this folder' }).fill('');
  await expect(dialog.getByRole('option', { name: 'subfolder' })).toBeVisible();
  await dialog.getByRole('option', { name: 'subfolder' }).dblclick();
  await expect(dialog.getByRole('option', { name: 'detail.draftcanvas' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(dialog.getByRole('option', { name: 'flow.draftcanvas' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(dialog.getByRole('option', { name: 'detail.draftcanvas' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Enclosing folder', exact: true }).click();
  await expect(dialog.getByRole('option', { name: 'flow.draftcanvas' })).toBeVisible();
  await page.evaluate(() => window.__shell.failNextExplorer('This folder needs permission. Choose another location.'));
  await places.getByRole('button', { name: 'Desktop', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('needs permission');
  await expect(dialog.getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
  await places.getByRole('button', { name: 'Downloads', exact: true }).click();
  await expect(dialog.getByRole('option')).toHaveCount(200);
  await dialog.getByRole('button', { name: 'Show more · 200 of 205' }).click();
  await expect(dialog.getByRole('option')).toHaveCount(205);
  await dialog.getByRole('option', { name: 'Folder 204' }).click();
  await expect(dialog.locator('.dc-explorer-destination')).toContainText('~/Downloads/Folder 204');
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show the Folder 204 project' })).toBeVisible();
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'pick_project').length)).toBe(0);
});

test('Open file shares the explorer with file selection, previews, and native menu access', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Selected from explorer', 3);
  await page.evaluate((text) => window.__shell.seed({ explorer: [{ name: 'Diagrams', path: '~/Documents/Diagrams', diagrams: [{ path: 'overview.draftcanvas', text, ago: 1000 }] }] }), text);
  const open = page.getByRole('button', { name: 'Open file…', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Open a diagram', exact: true });
  await expect(dialog.getByRole('button', { name: 'Open diagram', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Add project', exact: true })).toHaveCount(0);
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('option', { name: 'Diagrams', exact: true }).click();
  await dialog.getByRole('button', { name: 'Open folder', exact: true }).click();
  await dialog.getByRole('option', { name: 'overview.draftcanvas', exact: true }).click();
  await expect(dialog.getByRole('complementary', { name: 'Selection preview' }).locator('.dc-starter-glyph')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(open).toBeFocused();
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'explorer_open_file').length)).toBe(0);
  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'open' }));
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('option', { name: 'Diagrams', exact: true }).dblclick();
  await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Notes');
  await dialog.getByRole('textbox', { name: 'Folder name', exact: true }).press('Enter');
  await expect(dialog.getByRole('navigation', { name: 'Folder path' })).toContainText('Notes');
  await expect(dialog.getByRole('listbox', { name: 'Folders and diagrams' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Back', exact: true }).click();
  await dialog.getByRole('option', { name: 'overview.draftcanvas', exact: true }).click();
  await dialog.getByRole('button', { name: 'Open diagram', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.dc-title-input')).toHaveValue('Selected from explorer');

  // Cancelling a file switch leaves both unsaved work and the file explorer intact.
  // A corner clear of the node and of the agent companion, which rests in the bottom-right.
  const pane = await page.locator(CANVAS).boundingBox();
  await drawService(page, { x: pane!.width - 60, y: 80 });
  await page.evaluate(() => { window.__shell.answer(2); window.__shell.emit({ type: 'menu', command: 'open' }); });
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('option', { name: 'Diagrams', exact: true }).dblclick();
  await dialog.getByRole('option', { name: 'overview.draftcanvas', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.asked().length)).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(status(page)).toContainText('Unsaved changes');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('explorer creates a folder inline, handles errors, and adds it only on request', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Troubleshooting', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add project…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a project', exact: true });
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
  const form = dialog.getByRole('form', { name: 'Create a folder' });
  const name = form.getByRole('textbox', { name: 'Folder name' });
  await expect(name).toBeFocused();
  await expect(form.getByRole('button', { name: 'Create folder', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Add project', exact: true })).toBeDisabled();
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'New folder', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'explorer_create_folder').length)).toBe(0);

  await page.keyboard.press('Enter');
  await name.fill('../outside');
  await name.press('Enter');
  await expect(form.getByRole('alert')).toContainText('without slashes');
  await page.evaluate(() => window.__shell.failNextExplorer('This folder is read-only. Choose another location.'));
  await name.fill('New ideas');
  await name.press('Enter');
  await expect(form.getByRole('alert')).toContainText('read-only');
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('New ideas');
  await name.press('Enter');
  await expect(form).toBeHidden();
  await expect(dialog.getByRole('navigation', { name: 'Folder path' })).toContainText('New ideas');
  await expect(dialog.getByRole('navigation', { name: 'Folder path' })).toContainText('New ideas');
  await expect(dialog.getByRole('button', { name: 'Add project', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Add project', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'explorer_add_project').length)).toBe(0);

  // Returning to the parent lists the created folder; a duplicate never reuses it.
  await dialog.getByRole('button', { name: 'Enclosing folder', exact: true }).click();
  await expect(dialog.getByRole('option', { name: 'New ideas', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
  await name.fill('New ideas');
  await name.press('Enter');
  await expect(form.getByRole('alert')).toContainText('already exists');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Projects', exact: true })).toContainText('A home for related ideas.');

  // Creating is durable, but cancelling the explorer has not linked the folder as a project.
  await page.getByRole('button', { name: 'Add project…', exact: true }).click();
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('option', { name: 'New ideas', exact: true }).click();
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show the New ideas project', exact: true })).toBeVisible();
});

test('explorer opens a selected diagram without adding a project', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Opened in explorer', 2);
  await page.evaluate((text) => window.__shell.seed({ explorer: [{ name: 'Documents', path: '~/Documents', diagrams: [{ path: 'overview.draftcanvas', text, ago: 1000 }] }] }), text);
  await page.getByRole('button', { name: 'Add project…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a project', exact: true });
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('option', { name: 'overview.draftcanvas' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.dc-title-input')).toHaveValue('Opened in explorer');
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'explorer_add_project').length)).toBe(0);
  // A corner clear of the node and of the agent companion, which rests in the bottom-right.
  const pane = await page.locator(CANVAS).boundingBox();
  await drawService(page, { x: pane!.width - 60, y: 80 });
  await expect(status(page)).toContainText('Unsaved changes');
  await page.evaluate(() => {
    window.__shell.answer(2);
    window.__shell.emit({ type: 'menu', command: 'open-project' });
  });
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('option', { name: 'overview.draftcanvas' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__shell.asked().length)).toBe(1);
  await expect(dialog).toBeVisible();
  await expect(status(page)).toContainText('Unsaved changes');
  await page.evaluate(() => window.__shell.answer(1));
  await dialog.getByRole('button', { name: 'Open diagram', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText('Saved');
});

test('the gallery shares white light surfaces and teal actions with Home, and reflows real previews', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const text = await documentText(page, 'System', 3);
  await page.addInitScript((text) => {
    window.__shell.seed({ drafts: Array.from({ length: 7 }, (_, index) => ({ title: `Draft ${index + 1}`, text, ago: (index + 1) * 60_000 })) });
  }, text);
  await reloadSeeded(page);
  await expect(page.locator('.dc-living-primary')).toHaveCSS('background-color', 'rgb(13, 110, 101)');
  await expect(page.locator('.dc-living-primary')).toHaveCSS('color', 'rgb(255, 255, 255)');
  const homeAccent = await page.locator('.dc-desk').evaluate(el => getComputedStyle(el).getPropertyValue('--dc-selection').trim());
  await page.getByRole('button', { name: 'Find a diagram', exact: true }).click();
  await expect(page.locator('.dc-gallery-card')).toHaveCount(7);
  expect(await page.locator('.dc-desk').evaluate(el => getComputedStyle(el).getPropertyValue('--dc-selection').trim())).toBe(homeAccent);
  expect(homeAccent).toBe('#eae7e1');
  for (const [width, columns] of [[1200, 3], [760, 2], [375, 1]]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.locator('.dc-gallery-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(columns);
    await expect.poll(() => page.locator('.dc-gallery-grid').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator(':root')).toHaveAttribute('data-theme', 'light');
  expect(await page.locator('.dc-desk').evaluate(el => getComputedStyle(el).getPropertyValue('--dc-selection').trim())).toBe('#292827');
  await expect(page.locator('.dc-desk')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const primary = page.locator('.dc-gallery-heading .dc-button-solid');
  await expect(primary).toHaveCSS('background-color', 'rgb(13, 110, 101)');
  await primary.hover();
  await expect(primary).toHaveCSS('color', 'rgb(255, 255, 255)');
});

test('a Quick Draft starts drawing at once and becomes a file on Save', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Quick Draft' }).click();

  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(status(page)).toContainText('Quick Draft');
  await expect(status(page)).toContainText('Kept on this computer until you save it');

  await drawService(page);
  await expect(page.locator('.dc-node')).toHaveCount(1);

  await page.keyboard.press('Meta+s');
  const saveDialog = page.getByRole('dialog', { name: 'Save diagram as', exact: true });
  await saveDialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await saveDialog.getByRole('textbox', { name: 'File name', exact: true }).fill('meeting');
  await saveDialog.getByRole('button', { name: 'Save diagram', exact: true }).click();
  await expect(saveDialog).toBeHidden();

  await expect(status(page)).toContainText('Saved');
  await expect(status(page)).toContainText('~/Documents/meeting.draftcanvas');
  const saved = await page.evaluate(() => {
    const handle = window.__shell.calls().filter(call => call.command === 'report_state').map(call => (call.args as { state: { handle?: string } }).state.handle).filter(Boolean).at(-1)!;
    const file = window.__shell.file(handle)!;
    return { text: file.text, name: file.name };
  });
  expect(saved.name).toBe('meeting');
  const parsed = JSON.parse(saved.text) as { format: string; nodes: unknown[] };
  expect(parsed.format).toBe('draft-canvas');
  expect(parsed.nodes).toHaveLength(1);
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  await expect(page.getByRole('tab', { name: 'Drafts' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
});

test('Save As uses the shared explorer, keeps cancellation safe, and confirms existing targets', async ({ page }) => {
  await page.goto('/');
  const original = await documentText(page, 'Original diagram', 2);
  const existing = await documentText(page, 'Existing diagram', 1);
  const handles = await page.evaluate(({ original, existing }) => ({
    source: window.__shell.addFile('source', original),
    target: window.__shell.addFile('existing', existing),
  }), { original, existing });
  await page.getByRole('button', { name: 'Open file…', exact: true }).click();
  await chooseWorkFile(page, 'source');
  // The native Save As menu is enabled only once the file has finished opening.
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(status(page)).toContainText('~/work/source.draftcanvas');
  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'save-as' }));
  const dialog = page.getByRole('dialog', { name: 'Save diagram as', exact: true });
  const name = dialog.getByRole('textbox', { name: 'File name', exact: true });
  await expect(name).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save diagram', exact: true })).toBeEnabled();
  await name.fill('cancelled');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText('~/work/source.draftcanvas');
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'explorer_save_file').length)).toBe(0);

  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'save-as' }));
  await dialog.getByRole('option', { name: 'work', exact: true }).dblclick();
  await dialog.getByRole('option', { name: 'existing.draftcanvas', exact: true }).click();
  await expect(name).toHaveValue('existing');
  await dialog.getByRole('button', { name: 'Save diagram', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  expect(await page.evaluate(handle => window.__shell.file(handle)!.text, handles.target)).toBe(existing);
  await page.evaluate(handle => { const file = window.__shell.file(handle)!; file.text = 'outside edit'; file.version += 1; }, handles.target);
  await dialog.getByRole('button', { name: 'Replace diagram', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('changed since confirmation');
  expect(await page.evaluate(handle => window.__shell.file(handle)!.text, handles.target)).toBe('outside edit');
  await dialog.getByRole('button', { name: 'Change name', exact: true }).click();
  await expect(name).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Replace diagram', exact: true })).toHaveCount(0);
  await name.fill('existing');
  await dialog.getByRole('button', { name: 'Save diagram', exact: true }).click();
  await dialog.getByRole('button', { name: 'Replace diagram', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText('~/work/existing.draftcanvas');
  expect(await page.evaluate(handle => window.__shell.file(handle)!.text, handles.target)).toBe(original);
  expect(await page.evaluate(handle => window.__shell.file(handle)!.text, handles.source)).toBe(original);
  expect(await page.evaluate(() => window.__shell.calls().filter(call => call.command === 'save_as').length)).toBe(0);
  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'save-as' }));
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.__shell.emit({ type: 'new-quick-draft' }));
  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText('Quick Draft');
});

test('Save As creates a folder and recovers from an inline save error', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Quick Draft', exact: true }).click();
  await drawService(page);
  await page.keyboard.press('Meta+s');
  const dialog = page.getByRole('dialog', { name: 'Save diagram as', exact: true });
  await dialog.getByRole('complementary', { name: 'Places' }).getByRole('button', { name: 'Documents', exact: true }).click();
  await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill('New project');
  await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  const name = dialog.getByRole('textbox', { name: 'File name', exact: true });
  await expect(name).toBeFocused();
  await name.fill('overview');
  await page.evaluate(() => window.__shell.failNextExplorer('This folder is read-only. Choose another location.'));
  await name.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('read-only');
  await expect(name).toHaveValue('overview');
  await expect(status(page)).toContainText('Quick Draft');
  await dialog.getByRole('button', { name: 'Save diagram', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(status(page)).toContainText('~/Documents/New project/overview.draftcanvas');
  await expect(status(page)).toContainText('Saved');
});

test('what is unsaved is kept, and offered back from Home', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New Quick Draft' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await drawService(page);

  // The snapshot follows a short quiet spell, so it is written by the time the user has moved on.
  await expect.poll(() => page.evaluate(() => window.__shell.recoveryIds().length)).toBe(1);

  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  // The shared welcome stays in place as the first drawing appears on the shelf.
  await expect(page.getByRole('tab', { name: 'Drafts' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab')).toHaveText(['Drafts', 'Projects']);
  await expect(page.locator('.dc-desk')).toHaveAttribute('data-mode', 'returning');
  await expect(page.getByRole('heading', { name: HOME_HEADLINE })).toBeVisible();
  const tile = page.getByRole('button', { name: 'Open Quick Draft, a draft not saved to a file' });
  await expect(tile).toHaveAttribute('data-thumbnail', 'drawn');
  // A Quick Draft is not asked about on the way out.
  expect(await page.evaluate(() => window.__shell.asked())).toEqual([]);

  await tile.click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-node')).toHaveCount(1);
});

test('clearing Recent hides its tab and selects a remaining project', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 2);
  await page.addInitScript((text) => {
    window.__shell.seed({
      recents: [1, 2].map(index => ({ name: `payment-flow-${index}`, text, ago: index * 60_000 })),
      projects: [{ name: 'Payments', diagrams: [{ path: 'flow.draftcanvas', text, ago: 60_000 }] }],
    });
  }, text);
  await reloadSeeded(page);

  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Clear recent', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Projects', exact: true }).getByRole('button', { name: 'Show the Payments project' })).toBeVisible();
});

test('removing the last recent selects Drafts, then discarding the last draft selects Projects', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 2);
  await page.addInitScript((text) => {
    window.__shell.seed({ recents: [{ name: 'payment-flow', text, ago: 60_000 }], drafts: [{ title: 'Auth rework', text, ago: 60_000 }] });
  }, text);
  await reloadSeeded(page);

  await page.getByRole('tab', { name: 'Recent' }).click();
  await page.getByRole('button', { name: 'Remove payment-flow from Recent' }).click();
  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Drafts' })).toHaveAttribute('aria-selected', 'true');

  await page.evaluate(() => window.__shell.answer(0));
  await page.getByRole('tab', { name: 'Drafts' }).click();
  await page.getByRole('button', { name: 'Discard Auth rework' }).click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Projects', exact: true })).toBeVisible();
  await expect(page.locator('.dc-desk')).toHaveAttribute('data-mode', 'first');
  await expect(page.getByRole('heading', { name: HOME_HEADLINE })).toBeVisible();
});

test('the row is walked and opened from the keyboard', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 2);
  await page.addInitScript((text) => {
    window.__shell.seed({ recents: [1, 2, 3].map((i) => ({ name: `diagram-${i}`, text, ago: i * 60_000 })) });
  }, text);
  await reloadSeeded(page);

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

test('a first run keeps the full welcome', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.dc-desk')).toHaveAttribute('data-mode', 'first');
  await expect(page.getByRole('heading', { name: HOME_HEADLINE })).toBeVisible();
  await expect(page.getByText('No title needed. Just begin.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open file…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try an example' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect an agent…' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New file…' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'More ways in' })).toHaveCount(0);
});

test('recent files are drawn from their own contents, without being opened', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Payments', 3);
  await page.evaluate((text) => {
    window.__shell.addFile('payments', text);
  }, text);
  await page.getByRole('button', { name: 'Open file…' }).click();
  await chooseWorkFile(page, 'payments');
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();

  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  const tile = page.getByRole('button', { name: 'Open payments' });
  await expect(tile).toHaveAttribute('data-thumbnail', 'drawn');
  // Three services on the canvas, three marks on the tile.
  await expect(tile.locator('.dc-fingerprint-service')).toHaveCount(3);
  // Drawing it was a look, not an open: nothing but the one real open reached the shell.
  const opens = await page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'explorer_open_file' || call.command === 'open_handle').length);
  expect(opens).toBe(1);

  // The hero still starts an example directly, without a Starters tab.
  await page.getByRole('button', { name: 'Try an example' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-status-left')).toContainText('Quick Draft');
  expect(await page.locator('.dc-node').count()).toBeGreaterThan(3);
});

test('keeps the row to one line, with the rest one click away', async ({ page }) => {
  await page.goto('/');
  const text = await documentText(page, 'Flow', 2);
  await page.addInitScript((text) => {
    window.__shell.seed({ recents: Array.from({ length: 8 }, (_, i) => ({ name: `diagram-${i + 1}`, text, ago: (i + 1) * 60_000 })) });
  }, text);
  await reloadSeeded(page);

  await expect(page.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true');
  const row = page.locator('.dc-desk-row');
  const more = page.getByRole('button', { name: 'All 8' });
  await expect(more).toBeVisible();
  // Every tile in one row: nothing wraps under the connectors.
  const tops = await row.locator('.dc-desk-tile').evaluateAll((tiles) => new Set(tiles.map((tile) => (tile as HTMLElement).offsetTop)).size);
  expect(tops).toBe(1);

  // The small header link opens the complete gallery without using a preview slot.
  await expect(row.locator('[data-kind="more"]')).toHaveCount(0);
  await more.click();
  const recent = page.getByRole('region', { name: 'Recent' });
  await expect(recent.locator('.dc-desk-tile')).toHaveCount(8);
  await expect(page.getByRole('button', { name: /^Recent/, pressed: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  // Back on Home, the row is as full as it was.
  await expect(row.locator('.dc-desk-tile')).toHaveCount(await row.locator('.dc-desk-tile').count());
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
  await reloadSeeded(page);

  // Any number of projects is one source. With no other source, its previews need no tab bar.
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Projects', exact: true })).toBeVisible();
  const row = page.locator('.dc-desk-row');
  await expect(page.getByRole('button', { name: 'All 10' })).toBeVisible();
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
  // The search summary — the page also holds the screen-reader announcer's own status regions.
  await expect(page.getByRole('status').filter({ hasText: /diagrams? match/ })).toHaveText(/^\d+ diagrams? match/);
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
  await reloadSeeded(page);

  const row = page.locator('.dc-desk-row');
  await row.getByRole('button', { name: 'Show the Shop project' }).click();
  const group = page.getByRole('region', { name: 'Shop' });

  // The root heading already names the folder: a one-item breadcrumb would repeat it.
  await expect(page.getByRole('navigation', { name: 'Folder' })).toHaveCount(0);
  await expect(group.getByRole('heading', { name: 'Shop', exact: true })).toBeVisible();
  // At the root: the two files there, and one tile for the folder — not its contents.
  await expect(group.locator('.dc-desk-tile')).toHaveCount(3);
  await expect(group.getByRole('button', { name: 'Open home', exact: true })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Open the checkout folder' })).toBeVisible();

  // A search from the root still reaches into the folder, unlike browsing it.
  await page.getByLabel('Find a diagram').fill('step-1');
  // The search summary — the page also holds the screen-reader announcer's own status regions.
  await expect(page.getByRole('status').filter({ hasText: /diagrams? match/ })).toHaveText(/^\d+ diagrams? match/);
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
  await expect(crumbs).toHaveCount(0);
  await expect(group.locator('.dc-desk-tile')).toHaveCount(3);
});

test('opens diagrams from a project’s root and its subfolders, namesakes and nested projects included', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const texts = {
    root: await documentText(page, 'Root canvas', 1),
    sub: await documentText(page, 'Sub canvas', 2),
    deep: await documentText(page, 'Deep canvas', 3),
  };
  // The layout that crashed: a project and one of its own subfolders both on Home, every folder holding
  // an "Untitled canvas", one of them a level down and named in spaces and Unicode.
  await page.addInitScript((texts) => {
    window.__shell.seed({
      projects: [
        { name: 'sub Folder', path: 'Demo Project/sub Folder', diagrams: [{ path: 'Untitled canvas.draftcanvas', text: texts.sub, ago: 1_000 }] },
        {
          name: 'Demo Project',
          diagrams: [
            { path: 'Untitled canvas.draftcanvas', text: texts.root, ago: 30_000 },
            { path: 'sub Folder/Untitled canvas.draftcanvas', text: texts.sub, ago: 1_000 },
            { path: 'sub Folder/設計 é/Untitled canvas.draftcanvas', text: texts.deep, ago: 2_000 },
          ],
        },
      ],
    });
  }, texts);
  await reloadSeeded(page);

  const steps: { project: string; folders: string[]; path: string; shapes: number }[] = [
    { project: 'Demo Project', folders: [], path: 'Demo Project/Untitled canvas', shapes: 1 },
    { project: 'Demo Project', folders: ['sub Folder'], path: 'Demo Project/sub Folder/Untitled canvas', shapes: 2 },
    { project: 'Demo Project', folders: ['sub Folder', '設計 é'], path: 'Demo Project/sub Folder/設計 é/Untitled canvas', shapes: 3 },
    { project: 'sub Folder', folders: [], path: 'Demo Project/sub Folder/Untitled canvas', shapes: 2 },
    { project: 'Demo Project', folders: [], path: 'Demo Project/Untitled canvas', shapes: 1 },
  ];
  for (const [index, step] of steps.entries()) {
    if (index > 0) {
      // Back to Find a Diagram, standing in the folder the last one was opened from — where it crashed.
      await page.getByRole('button', { name: 'Back to your diagrams' }).click();
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
    } else {
      await page.locator('.dc-desk-row').getByRole('button', { name: `Show the ${step.project} project` }).click();
    }
    const scope = page.getByRole('navigation', { name: 'Show' }).getByRole('button', { name: new RegExp(`^${step.project}`) });
    if ((await scope.getAttribute('aria-pressed')) !== 'true') await scope.click();
    const group = page.getByRole('region', { name: step.project });
    const top = page.getByRole('navigation', { name: 'Folder' }).getByRole('button', { name: step.project, exact: true });
    if (await top.count()) await top.click();
    for (const name of step.folders) await group.getByRole('button', { name: `Open the ${name} folder` }).click();
    await group.getByRole('button', { name: 'Open Untitled canvas', exact: true }).click();

    await expect(status(page)).toContainText(`~/work/${step.path}.draftcanvas`);
    await expect(page.locator('.react-flow__node')).toHaveCount(step.shapes);
  }
  expect(errors).toEqual([]);
});

test('Home’s dotted canvas is quieter in dark mode, and exactly as it was in light — before and after switching', async ({ page }) => {
  const dots = () =>
    page.locator('.dc-desk-canvas').evaluate((el) => {
      const before = getComputedStyle(el, '::before');
      return { ink: getComputedStyle(el).getPropertyValue('--dc-home-dot').trim(), dot: before.backgroundImage, size: before.backgroundSize };
    });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('.dc-desk-canvas')).toHaveCount(1);
  const light = await dots();
  // The light canvas's own values, untouched: 17% of the faint ink, 1.1px dots on an 18px grid.
  expect(light.ink).toMatch(/^color-mix\(in srgb, \S+ 17%, transparent\)$/);
  expect(light.dot).toMatch(/1\.1px, (rgba\(0, 0, 0, 0\)|transparent) 1\.5px/);
  expect(light.size).toBe('18px 18px');

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator(':root[data-theme="dark"]')).toHaveCount(1);
  const dark = await dots();
  expect(dark.ink).toMatch(/^color-mix\(in srgb, \S+ 9%, transparent\)$/);
  expect(dark.dot).toMatch(/ 1px, (rgba\(0, 0, 0, 0\)|transparent) 1\.4px/);
  // Spacing stays: only the ink and the dot's size move.
  expect(dark.size).toBe('18px 18px');

  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator(':root[data-theme="light"]')).toHaveCount(1);
  expect(await dots()).toEqual(light);
});

test('renames the open file in place, from the File menu', async ({ page }) => {
  await page.goto('/');
  // The open event below is dropped if it beats host_ready; Home renders after that handshake.
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
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
    window.__shell.addFile('payments', text);
  }, text);

  await page.getByRole('button', { name: 'Open file…' }).click();
  await chooseWorkFile(page, 'payments');
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-node')).toHaveCount(1);
  await expect(status(page)).toContainText('Saved');
  await expect(status(page)).toContainText('~/work/payments.draftcanvas');

  // Opening an existing diagram now frames its content, so the one node here sits centred in the
  // pane rather than near its old default position — draw well into a corner instead of a fixed
  // centre-ish point, so this doesn't land back on top of it. The top-right one: the agent companion
  // rests in the bottom-right.
  const pane = await page.locator(CANVAS).boundingBox();
  await drawService(page, { x: pane!.width - 60, y: 80 });
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
  // Home renders after host_ready attaches the event channel. Sending a fake OS event before
  // that handshake drops it in the mock, unlike an event delivered to the visible native app.
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
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

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Export/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export & share' });
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

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Export/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export & share' });
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
  // The new shape opens ready to name; while its editor has the keyboard, Undo is the editor's.
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-node-editor')).toHaveCount(0);

  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'undo' }));
  await expect(page.locator('.dc-node')).toHaveCount(0);

  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'redo' }));
  await expect(page.locator('.dc-node')).toHaveCount(1);
});

test('a file that is not a diagram is refused without leaving Home', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    window.__shell.addFile('notes', '{ definitely not a diagram');
  });

  await page.getByRole('button', { name: 'Open file…' }).click();
  await chooseWorkFile(page, 'notes');
  await expect(page.getByRole('dialog', { name: 'Open a diagram', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: 'Open a diagram', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();

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

test('the full changelog renders as a link and opens in the system browser', async ({ page }) => {
  // Exercise the published notes pipeline: 1.15.2 displayed this closing link as raw Markdown.
  const info = {
    version: '1.16.0',
    notes: desktopNotes(readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'), '1.16.0', 'v1.16.0'),
  };
  const url = 'https://github.com/acltabontabon/draft-canvas/blob/v1.16.0/CHANGELOG.md#1160---2026-10-25';
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  await page.evaluate(
    (info) => window.__shell.setUpdate({ currentVersion: '1.15.2', state: { phase: 'available', info }, dismissed: false, held: null, error: null }),
    info,
  );
  await page.getByRole('button', { name: 'Update available · 1.16.0' }).click();
  const dialog = page.getByRole('dialog', { name: 'A new version of Draft Canvas' });
  const notes = dialog.getByRole('region', { name: 'What’s new' });
  const link = notes.getByRole('link', { name: '1.16.0', exact: true });
  await expect(notes.getByText('Full changelog:', { exact: false })).toHaveText('Full changelog: 1.16.0');
  await expect(link).toHaveAttribute('href', url);

  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await expect(page.locator(':root')).toHaveAttribute('data-theme', theme);
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeVisible();
    expect(await notes.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (theme === 'light') await link.click();
    else {
      await link.focus();
      await expect(link).toBeFocused();
      await link.press('Enter');
    }
    await expect.poll(() => page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'open_external'))).toEqual(
      Array.from({ length: theme === 'light' ? 1 : 2 }, () => ({ command: 'open_external', args: { url } })),
    );
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL('http://localhost:5199/');
  }
});

/** Opens Settings the way the menu does, on the page named. */
async function openSettings(page: Page, category?: 'General' | 'Canvas' | 'AI agents' | 'Updates' | 'Support') {
  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'settings' }));
  const settings = page.getByRole('dialog', { name: 'Settings' });
  if (category) await settings.getByRole('tab', { name: category }).click();
  return settings;
}

test('Settings fits a compact window and keeps every page accessible in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const settings = await openSettings(page);
  for (const theme of ['light', 'dark'] as const) {
    // Reduced motion turns off the tabs' 90 ms colour transition: checked straight after the theme
    // changed, a tab still fading between the two themes' greys measured 3.34:1.
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await expect(page.locator(':root')).toHaveAttribute('data-theme', theme);
    for (const category of ['General', 'Canvas', 'AI agents', 'Updates', 'Support']) {
      await settings.getByRole('tab', { name: category, exact: true }).click();
      const panel = settings.getByRole('tabpanel', { name: category, exact: true });
      await expect(panel).toBeVisible();
      expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      const result = await new AxeBuilder({ page }).include('.dc-modal-settings').analyze();
      expect(result.violations).toEqual([]);
    }
  }
});

test('Canvas settings is a page of Settings, however it is asked for', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();

  // On Home: this device's drawing style and suggestions, and no diagram to give a background.
  let settings = await openSettings(page, 'Canvas');
  let panel = settings.getByRole('tabpanel', { name: 'Canvas', exact: true });
  await panel.getByRole('radio', { name: /^Sketch/ }).check();
  await expect(page.locator(':root')).toHaveAttribute('data-personality', 'sketch');
  await expect(panel.getByRole('switch', { name: 'Suggest the next move while drawing' })).toBeChecked();
  await expect(panel.getByText('Open a diagram to give it a background.')).toBeVisible();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'New Quick Draft' }).click();
  await expect(page.locator(CANVAS)).toBeVisible();
  const canvasPage = async () => {
    settings = page.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByRole('tab', { name: 'Canvas', exact: true })).toHaveAttribute('aria-selected', 'true');
    panel = settings.getByRole('tabpanel', { name: 'Canvas', exact: true });
    await expect(panel.getByRole('button', { name: 'Choose image…', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Canvas settings' })).toHaveCount(0);
    await settings.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(settings).toBeHidden();
  };
  // The menu bar's Canvas Settings…, the status bar's button and ⌘K all land on the same page.
  await page.evaluate(() => window.__shell.emit({ type: 'menu', command: 'canvas-settings' }));
  await canvasPage();
  await page.getByRole('button', { name: 'Canvas settings', exact: true }).click();
  await canvasPage();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
  await page.keyboard.type('Canvas settings');
  await expect(page.getByRole('option', { selected: true })).toContainText('Canvas settings');
  await page.keyboard.press('Enter');
  await canvasPage();
});

test('Settings has the update switch, and turning it off tells the shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const settings = await openSettings(page, 'Updates');
  const auto = settings.getByRole('switch', { name: /Check for updates automatically/ });
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

test('Settings → AI agents is off until turned on, and each folder is allowed on its own', async ({ page }) => {
  await page.addInitScript(() => window.__shell.seed({ projects: [{ name: 'platform', diagrams: [] }, { name: 'payments', diagrams: [] }] }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const settings = await openSettings(page, 'AI agents');
  const access = settings.getByRole('switch', { name: 'Allow agent access' });
  await expect(access).not.toBeChecked();
  // While access is off the folders stay in view, kept as they were but out of reach.
  const folders = settings.getByRole('group', { name: 'Allowed folders' });
  await expect(folders.getByRole('checkbox', { name: /platform/ })).toBeDisabled();
  await expect(folders.getByRole('checkbox', { name: /payments/ })).toBeDisabled();

  await access.check();
  await expect(access).toBeChecked();
  const platform = folders.getByRole('checkbox', { name: /platform/ });
  const payments = folders.getByRole('checkbox', { name: /payments/ });
  await expect(platform).toBeEnabled();
  await expect(platform).not.toBeChecked();
  await expect(payments).not.toBeChecked();
  await payments.check();
  await expect(payments).toBeChecked();
  await expect(platform).not.toBeChecked();
  await expect(settings.getByRole('status').filter({ hasText: 'Restart Draft Canvas so agents can reach it while its window is hidden.' })).toBeVisible();
  // The connector's path, ready to paste into an agent's setup — never the secret.
  await expect(settings.getByText('claude mcp add --scope user draft-canvas -- "/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp"')).toBeVisible();

  const patches = await page.evaluate(() =>
    window.__shell
      .calls()
      .filter((call) => call.command === 'agent_configure')
      .map((call) => (call.args as { patch: unknown }).patch),
  );
  expect(patches[0]).toEqual({ enabled: true });
  expect(patches[1]).toMatchObject({ project: { agent: true } });
});

test('Settings moves between pages by keyboard, shows one agent setup at a time, and ends connections apart from setup', async ({ page, browserName }) => {
  await page.addInitScript(() =>
    window.__shell.seed({
      projects: [
        { name: 'platform', diagrams: [] },
        { name: 'web', path: 'platform/web', diagrams: [] },
        { name: 'platform-tools', diagrams: [] },
      ],
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const settings = await openSettings(page);

  // It opens on the page it was last left at (General, the first time), with focus on that tab.
  const general = settings.getByRole('tab', { name: 'General' });
  await expect(general).toHaveAttribute('aria-selected', 'true');
  await expect(general).toBeFocused();
  await settings.getByRole('radio', { name: 'Quit Draft Canvas' }).check();
  await expect
    .poll(() => page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'settings_set').map((call) => (call.args as { patch: unknown }).patch)))
    .toContainEqual({ closeBehavior: 'quit' });

  await general.focus();
  await page.keyboard.press('ArrowDown');
  await expect(settings.getByRole('tab', { name: 'Canvas' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const agents = settings.getByRole('tab', { name: 'AI agents' });
  await expect(agents).toBeFocused();
  await expect(agents).toHaveAttribute('aria-selected', 'true');
  await expect(settings.getByRole('tabpanel', { name: 'AI agents' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(settings.getByRole('tab', { name: 'Support' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(general).toHaveAttribute('aria-selected', 'true');
  await agents.click();

  // Nothing to disconnect until access is on.
  const disconnect = settings.getByRole('button', { name: 'Disconnect agents' });
  await expect(disconnect).toBeDisabled();
  await settings.getByRole('switch', { name: 'Allow agent access' }).check();
  await expect(disconnect).toBeEnabled();

  // A ticked folder reaches the folder inside it — said on the inner row, whose own box is left alone.
  const folders = settings.getByRole('group', { name: 'Allowed folders' });
  await folders.getByRole('checkbox', { name: /^platform ~\/work\/platform$/ }).check();
  const web = folders.getByRole('checkbox', { name: /web/ });
  await expect(web).not.toBeChecked();
  await expect(web).toHaveAccessibleDescription('Already reachable through platform');
  await expect(folders.getByRole('checkbox', { name: /platform-tools/ })).not.toHaveAccessibleDescription(/reachable/);

  // One client's setup at a time.
  const command = settings.getByText(/^claude mcp add --scope user draft-canvas/);
  await expect(command).toBeVisible();
  await expect(settings.getByText(/"mcpServers"/)).toHaveCount(0);
  // The segmented control's radios are visually hidden; its label is what a pointer presses.
  await settings.getByRole('radio', { name: 'Codex' }).check({ force: true });
  await expect(command).toHaveCount(0);
  // Codex is set up by the shell itself; the by-hand entry stays tucked away until asked for.
  const toml = settings.getByText(/\[mcp_servers\.draft-canvas\]/);
  await expect(toml).toBeHidden();
  await settings.getByRole('button', { name: 'Add to Codex' }).click();
  await expect(settings.getByRole('status').filter({ hasText: 'Set up in ~/.codex/config.toml. Start a new Codex chat to use it.' })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Add to Codex' })).toHaveCount(0);
  const connects = await page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'agent_connect_client').map((call) => call.args));
  expect(connects).toEqual([{ client: 'codex' }]);
  await settings.getByRole('button', { name: 'Set it up by hand instead' }).click();
  await expect(toml).toBeVisible();
  // Gemini CLI runs its own `mcp add`; Junie's file is written by the shell. Each says where it went.
  await settings.getByRole('radio', { name: 'Gemini CLI' }).check({ force: true });
  await expect(settings.getByText(/^gemini mcp add --scope user draft-canvas/)).toBeHidden();
  await settings.getByRole('button', { name: 'Add to Gemini CLI' }).click();
  await expect(settings.getByRole('status').filter({ hasText: 'Set up in ~/.gemini/settings.json. Start a new Gemini CLI session in a trusted folder to use it.' })).toBeVisible();
  await settings.getByRole('radio', { name: 'Junie' }).check({ force: true });
  await settings.getByRole('button', { name: 'Add to Junie' }).click();
  await expect(settings.getByRole('status').filter({ hasText: 'Set up in ~/.junie/mcp/mcp.json. Start a new Junie session to use it.' })).toBeVisible();
  const allConnects = await page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'agent_connect_client').map((call) => call.args));
  expect(allConnects).toEqual([{ client: 'codex' }, { client: 'gemini' }, { client: 'junie' }]);
  await settings.getByRole('radio', { name: 'Cursor' }).check({ force: true });
  await expect(command).toHaveCount(0);
  await expect(settings.getByRole('link', { name: 'Add to Cursor' })).toHaveAttribute('href', /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install/);
  const fallback = settings.getByRole('button', { name: 'Copy the config instead' });
  await expect(fallback).toHaveAttribute('aria-expanded', 'false');
  await fallback.click();
  await expect(fallback).toHaveAttribute('aria-expanded', 'true');
  await expect(settings.getByText(/"mcpServers"/)).toBeVisible();
  await settings.getByRole('radio', { name: 'Other MCP clients' }).check({ force: true });
  // Reading the clipboard back needs a permission only Chromium lets a test grant; the copy itself
  // (a click, so a user gesture) works everywhere.
  const readBack = browserName === 'chromium';
  if (readBack) await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await settings.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Copied' })).toBeVisible();
  // The whole config, not just what the block has room to show.
  if (readBack) {
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual({
      mcpServers: { 'draft-canvas': { command: '/Applications/Draft Canvas.app/Contents/MacOS/draft-canvas-mcp' } },
    });
  }

  // Ending connections is its own action, and says it happened.
  await page.evaluate(() => window.__shell.setAgent({ connections: 2 }));
  await expect(settings.getByRole('status').filter({ hasText: '2 connected' })).toBeVisible();
  await disconnect.click();
  await expect(disconnect).toHaveText('Disconnected');
  await expect(settings.getByRole('status').filter({ hasText: 'None connected' })).toBeVisible();
  const patches = await page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'agent_configure').map((call) => (call.args as { patch: unknown }).patch));
  expect(patches).toContainEqual({ rotate: true });

  // Escape closes Settings; reopening returns to the page it was left on.
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await openSettings(page);
  await expect(settings.getByRole('tab', { name: 'AI agents' })).toHaveAttribute('aria-selected', 'true');
});

test('Settings → Support previews a diagnostic report and saves the reviewed bytes', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const settings = await openSettings(page, 'Support');
  const preview = settings.getByRole('textbox', { name: 'Diagnostic report contents' });
  const report = await preview.inputValue();
  expect(JSON.parse(report)).toMatchObject({ format: 1, events: [] });
  await settings.getByRole('button', { name: 'Download report' }).click();
  await expect.poll(() => page.evaluate(() => window.__shell.exports())).toEqual([
    { name: 'draft-canvas-diagnostics.json', text: report },
  ]);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
});

test('Settings installs the agent skill where the chosen agent reads skills, and takes it out again', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const settings = await openSettings(page, 'AI agents');
  await settings.getByRole('switch', { name: 'Allow agent access' }).check();
  const installs = () => page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'agent_install_skill').map((call) => call.args));

  // Claude Code reads its own folder.
  await expect(settings.getByText(/Teaches Claude Code to draw a repository well/)).toBeVisible();
  await settings.getByRole('button', { name: 'Install skill' }).click();
  await expect(settings.getByRole('status').filter({ hasText: 'Skill installed in ~/.claude/skills/draft-canvas.' })).toBeVisible();
  expect(await installs()).toEqual([{ target: 'claude-code' }]);

  // Codex, Cursor, Gemini CLI and Junie share ~/.agents/skills: installed from one, it shows as installed in the others.
  await settings.getByRole('radio', { name: 'Codex' }).check({ force: true });
  await expect(settings.getByText(/Teaches Codex, Cursor, Gemini CLI and Junie to draw a repository well/)).toBeVisible();
  await settings.getByRole('button', { name: 'Install skill' }).click();
  await expect(settings.getByRole('status').filter({ hasText: 'Skill installed in ~/.agents/skills/draft-canvas.' })).toBeVisible();
  expect(await installs()).toEqual([{ target: 'claude-code' }, { target: 'agents' }]);
  await settings.getByRole('radio', { name: 'Gemini CLI' }).check({ force: true });
  await expect(settings.getByRole('status').filter({ hasText: 'Skill installed in ~/.agents/skills/draft-canvas.' })).toBeVisible();
  await settings.getByRole('radio', { name: 'Junie' }).check({ force: true });
  await expect(settings.getByRole('status').filter({ hasText: 'Skill installed in ~/.agents/skills/draft-canvas.' })).toBeVisible();
  await settings.getByRole('radio', { name: 'Cursor' }).check({ force: true });
  await expect(settings.getByRole('status').filter({ hasText: 'Skill installed in ~/.agents/skills/draft-canvas.' })).toBeVisible();

  await settings.getByRole('button', { name: 'Remove skill' }).click();
  await expect(settings.getByRole('button', { name: 'Install skill' })).toBeVisible();
  const removes = await page.evaluate(() => window.__shell.calls().filter((call) => call.command === 'agent_remove_skill').map((call) => call.args));
  expect(removes).toEqual([{ target: 'agents' }]);
});
