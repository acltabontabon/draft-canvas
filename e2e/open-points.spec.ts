import { expect, test, type Page } from '@playwright/test';

/**
 * The journey open points exist for: something is still unsettled mid-meeting, it gets marked on the
 * shape or connector it concerns in a couple of clicks, the drawing carries on — and the diagram
 * reopened later says where the discussion left off, and lets it be settled from there.
 *
 * Driven the way a person drives it (the menu, a click on a kind, typing, Escape) rather than through
 * the store, because the parts most likely to break are the guards between the gesture and the document.
 */

const CANVAS = '.react-flow__pane';
const MARKER = '.dc-open-point-marker';
const POPOVER = '.dc-open-point-popover';
const CHIP = '.dc-status-open-points';
const PANEL = '.dc-open-points';

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

async function create(page: Page, tool: string, at: { x: number; y: number }) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator(CANVAS).click({ position: at });
}

async function rename(page: Page, index: number, name: string) {
  await page.locator('.dc-node').nth(index).click();
  await page.keyboard.press('Enter');
  await expect(page.locator('.dc-node-editor')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(name);
  await page.locator(CANVAS).click({ position: { x: 60, y: 60 } });
  await expect(page.locator('.dc-node-editor')).toHaveCount(0);
}

async function connect(page: Page, fromIndex: number, toIndex: number) {
  const source = page.locator('.dc-node').nth(fromIndex);
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
}

test.describe('Open points', () => {
  test('marks a shape in two actions, keeps the drawing readable, survives a reload, and resolves from the overview', async ({ page }) => {
    await newCanvas(page, 'Payments platform');
    await create(page, 'Service', { x: 320, y: 300 });
    await rename(page, 0, 'Payment Service');
    await create(page, 'Service', { x: 760, y: 300 });
    await rename(page, 1, 'Settlement');
    await connect(page, 0, 1);
    await page.locator(CANVAS).click({ position: { x: 60, y: 60 } });

    // Nothing has been raised: no chip, no markers.
    await expect(page.locator(CHIP)).toHaveCount(0);
    await expect(page.locator(MARKER)).toHaveCount(0);

    // Right-click → Add open point → Tentative. The marker is on the shape before a word is typed.
    const service = page.locator('.dc-node').nth(0);
    const before = (await service.boundingBox())!;
    await service.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add open point…' }).click();
    await expect(page.locator(POPOVER)).toBeVisible();
    await page.getByRole('button', { name: 'Tentative' }).click();
    await expect(page.locator(MARKER)).toHaveCount(1);
    await expect(page.locator(MARKER)).toHaveAttribute('data-kind', 'tentative');
    // Optional context, typed straight in; Enter commits and closes.
    await expect(page.getByLabel('Context for tentative point')).toBeFocused();
    await page.keyboard.type('We think this call is asynchronous — confirm with the settlement team.');
    await page.keyboard.press('Enter');
    await expect(page.locator(POPOVER)).toHaveCount(0);
    // The shape itself has not moved or changed size.
    expect(await service.boundingBox()).toEqual(before);
    await expect(page.locator(CHIP)).toHaveAttribute('aria-label', /1 open point/);

    // The connector: Awaiting input, from its own menu. Its label stays where it was.
    const hit = page.locator('.dc-edge-hit').first();
    const box = (await hit.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Add open point…' }).click();
    await page.getByRole('button', { name: 'Awaiting input' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator(MARKER)).toHaveCount(2);
    await expect(page.locator(`${MARKER}[data-variant="edge"]`)).toHaveAttribute('data-kind', 'awaiting');
    await expect(page.locator(CHIP)).toHaveAttribute('aria-label', /2 open points/);

    // Hover says what is open without a click.
    await page.locator(`${MARKER}[data-variant="node"]`).hover();
    await expect(page.locator(`${MARKER}[data-variant="node"] .dc-open-point-preview`)).toContainText('Tentative');
    await expect(page.locator(`${MARKER}[data-variant="node"] .dc-open-point-preview`)).toContainText('confirm with the settlement team');

    // A reload brings the same points back — once autosave has written them.
    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'Payments platform' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await expect(page.locator(MARKER)).toHaveCount(2);
    await expect(page.locator(CHIP)).toHaveAttribute('aria-label', /2 open points/);

    // The overview lists them with what they are about; resolving one removes its marker only.
    await page.locator(CHIP).click();
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator(PANEL)).toContainText('Payment Service');
    await expect(page.locator(PANEL)).toContainText('Payment Service → Settlement');
    await page.locator(PANEL).getByRole('button', { name: 'Resolve' }).first().click();
    await expect(page.locator(MARKER)).toHaveCount(1);
    await expect(page.locator(CHIP)).toHaveAttribute('aria-label', /1 open point/);
    await expect(page.locator(PANEL)).toContainText('1 resolved');
    await expect(page.locator('.dc-node')).toHaveCount(2);

    // Resolving was an ordinary edit.
    await page.keyboard.press('Escape');
    await expect(page.locator(PANEL)).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator(MARKER)).toHaveCount(2);
  });

  test('deleting the shape takes its point; undo brings both back; Escape returns focus to the marker', async ({ page }) => {
    await newCanvas(page, 'Undo and focus');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add open point…' }).click();
    await page.getByRole('button', { name: 'Parked' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator(MARKER)).toHaveCount(1);

    // Open from the marker, close with Escape: focus lands back on the marker.
    await page.locator('.dc-node').first().click();
    await page.locator(MARKER).click();
    await expect(page.locator(POPOVER)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);
    await expect(page.locator(MARKER)).toBeFocused();

    await page.locator(CANVAS).click({ position: { x: 60, y: 60 } });
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('Delete');
    await expect(page.locator('.dc-node')).toHaveCount(0);
    await expect(page.locator(CHIP)).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(1);
    await expect(page.locator(MARKER)).toHaveCount(1);
  });

  test('a presenter can show a point read-only, and an export offers to leave the markers out', async ({ page }) => {
    await newCanvas(page, 'Present and export');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add open point…' }).click();
    await page.getByRole('button', { name: 'Awaiting input' }).click();
    await page.keyboard.type('Owner still to confirm');
    await page.keyboard.press('Escape');

    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
    await expect(page.locator(MARKER)).toHaveCount(1);
    await page.locator(MARKER).click();
    await expect(page.locator(POPOVER)).toHaveAttribute('data-read-only', 'true');
    await expect(page.locator(POPOVER)).toContainText('Owner still to confirm');
    await expect(page.locator(POPOVER).getByRole('button', { name: 'Resolve' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator(POPOVER)).toHaveCount(0);
    await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'edit');

    await page.keyboard.press('ControlOrMeta+Shift+e');
    const dialog = page.locator('.dc-modal-export');
    await expect(dialog).toBeVisible();
    const markers = dialog.getByLabel('Open point markers');
    await expect(markers).toBeChecked();
    const preview = () => dialog.locator('.dc-export-stage img').getAttribute('src');
    const withMarkers = await preview();
    expect(decodeURIComponent(withMarkers ?? '')).toContain('Open points');
    await markers.uncheck();
    await expect.poll(async () => decodeURIComponent((await preview()) ?? '')).not.toContain('Open points');
  });
});
