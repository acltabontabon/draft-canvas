import { expect, test, type Page } from '@playwright/test';

/**
 * The Export dialog itself, driven for real: how it is opened, how its modes are walked from the
 * keyboard, and the modes no other spec covers end to end. What it writes is the native file, a
 * PNG or an SVG, a share link and the docs bundle; it has no mode for another tool's text format.
 */

function sagaDocument() {
  return {
    format: 'draft-canvas',
    version: 10,
    metadata: { id: 'saga-doc', title: 'Payment Saga', createdAt: 1, updatedAt: 2 },
    nodes: [
      { id: 'customer', type: 'actor', x: 0, y: 0, width: 96, height: 84, z: 0, text: 'Customer' },
      { id: 'order-api', type: 'service', x: 260, y: 0, width: 176, height: 68, z: 0, text: 'Order API' },
      { id: 'payment-service', type: 'service', x: 520, y: 0, width: 176, height: 68, z: 0, text: 'Payment Service' },
    ],
    edges: [
      { id: 'e-place-order', source: 'customer', target: 'order-api', label: 'Place Order', directed: true, routing: 'smoothstep' },
      { id: 'e-charge-card', source: 'order-api', target: 'payment-service', label: 'Charge Card', directed: true, routing: 'smoothstep' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots' },
    flows: [
      {
        id: 'flow-happy',
        title: 'Happy Path',
        steps: [
          { id: 'hp1', edgeId: 'e-place-order' },
          { id: 'hp2', edgeId: 'e-charge-card' },
        ],
      },
    ],
  };
}

async function importDocument(page: Page, doc: unknown, fileName: string) {
  await page.goto('/');
  const input = page.locator('input[type="file"]');
  await input.waitFor({ state: 'attached' });
  await input.setInputFiles({
    name: fileName,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.locator('.dc-editor')).toBeVisible({ timeout: 15_000 });
}

async function openExport(page: Page) {
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Export/ }).click();
  await expect(page.getByRole('dialog', { name: 'Export & share' })).toBeVisible();
}

test.describe('Export dialog', () => {
  test('opens from the keyboard with ⌘⇧E — the chord extensions leave alone — and ⌘E too', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    const dialog = page.getByRole('dialog', { name: 'Export & share' });
    for (const chord of ['ControlOrMeta+Shift+E', 'ControlOrMeta+e']) {
      await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
      await page.keyboard.press(chord);
      await expect(dialog, chord).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }
  });

  test('offers a link, the editable file, an image and a README picture, and no other format', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    await openExport(page);
    const dialog = page.getByRole('dialog', { name: 'Export & share' });
    expect(await dialog.locator('.dc-export-mode').evaluateAll((modes) => modes.map((mode) => (mode as HTMLElement).dataset.mode))).toEqual(['share', 'document', 'image', 'docs']);
    await expect(dialog.getByRole('radio', { name: /Other formats/ })).toHaveCount(0);
  });

  test('Docs on the web downloads the bundle and stays open for the Markdown line', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    await openExport(page);
    const dialog = page.getByRole('dialog', { name: 'Export & share' });
    await dialog.locator('[data-mode="docs"]').click();
    await expect(dialog.getByLabel('Markdown for this picture')).toHaveText('![Payment Saga](diagrams/payment-saga.svg)');

    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download for docs' }).click();
    expect((await download).suggestedFilename()).toBe('payment-saga-docs.zip');
    // Pasting the line is the next step, so the dialog doesn't close under it.
    await expect(dialog.getByText('Downloaded payment-saga-docs.zip')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy Markdown' })).toBeEnabled();
  });

  test('is fully reachable by keyboard: switch mode, pick the format, export, close', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    await page.keyboard.press('Meta+e');
    const dialog = page.getByRole('dialog', { name: 'Export & share' });
    await expect(dialog).toBeVisible();

    // The mode picker and the Format segmented control are both real `<input type="radio">`
    // groups, so arrow-key navigation is native browser behavior a headless keyDown reliably
    // drives — unlike an OS-native <select> dropdown, which is why this exercises arrow keys
    // directly instead of `.selectOption()`.
    await dialog.getByRole('radio', { name: /Save an image/ }).focus(); // the default mode
    await page.keyboard.press('ArrowLeft'); // Save an image -> Save an editable file
    await expect(dialog.getByRole('radio', { name: /Save an editable file/ })).toBeChecked();

    await dialog.getByRole('radio', { name: 'Editable', exact: true }).focus();
    await page.keyboard.press('ArrowRight'); // Editable -> Encrypted
    await expect(dialog.getByRole('radio', { name: 'Encrypted', exact: true })).toBeChecked();
    await page.keyboard.press('ArrowLeft'); // and back
    await expect(dialog.getByRole('radio', { name: 'Editable', exact: true })).toBeChecked();

    const download = page.waitForEvent('download');
    // After Format: the privacy lock, then Export. A file has nothing to copy, so no Copy between.
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^Made on your device/);
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveText('Export file');
    await page.keyboard.press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toBe('payment-saga.draftcanvas');

    // The dialog closes itself on a successful export.
    await expect(page.getByRole('dialog', { name: 'Export & share' })).toHaveCount(0);
  });

  test('the mode picker is arrow-key navigable', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    await openExport(page);
    const dialog = page.getByRole('dialog', { name: 'Export & share' });

    await dialog.getByRole('radio', { name: /Save an editable file/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: /Save an image/ })).toBeFocused();
    await expect(dialog.getByRole('radio', { name: /Save an image/ })).toBeChecked();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: /Use in a README/ })).toBeFocused();
    await expect(dialog.getByRole('radio', { name: /Use in a README/ })).toBeChecked();
    // And back again. Whether one more press past the last choice wraps round to the first is the
    // browser's own radio behaviour (WebKit stays put), so it is not asserted here.
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.getByRole('radio', { name: /Save an image/ })).toBeFocused();
    await expect(dialog.getByRole('radio', { name: /Save an image/ })).toBeChecked();
  });
});
