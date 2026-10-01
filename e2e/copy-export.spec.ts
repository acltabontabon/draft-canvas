import { expect, test, type Page } from '@playwright/test';

/**
 * Copy is the file export pointed at the system clipboard. These drive the real Export dialog and
 * the command palette in Chromium with the clipboard permissions granted, then read the clipboard
 * back: the SVG text has to start with `<svg`, the source has to be the source, and an editable SVG
 * has to carry the diagram inside it.
 */

// Reading the clipboard back needs Chromium's permission grants; Firefox and WebKit refuse the
// permission names themselves, so this spec is Chromium-only.
test.skip(({ browserName }) => browserName !== 'chromium', 'clipboard-read is a Chromium permission');
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

function smallDocument() {
  return {
    format: 'draft-canvas',
    version: 10,
    metadata: { id: 'copy-doc', title: 'Copy Me', createdAt: 1, updatedAt: 2 },
    nodes: [
      { id: 'api', type: 'service', x: 0, y: 0, width: 176, height: 68, z: 0, text: 'Order API' },
      { id: 'db', type: 'database', x: 320, y: 0, width: 176, height: 68, z: 0, text: 'Orders DB' },
    ],
    edges: [{ id: 'e1', source: 'api', target: 'db', label: 'writes', directed: true, routing: 'smoothstep' }],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
    flows: [],
  };
}

async function importDocument(page: Page) {
  await page.goto('/');
  const input = page.locator('input[type="file"]');
  await input.waitFor({ state: 'attached' });
  await input.setInputFiles({ name: 'copy.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(smallDocument())) });
  await expect(page.locator('.dc-editor')).toBeVisible({ timeout: 15_000 });
}

async function openExport(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const clipboardText = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.describe('Copy export', () => {
  test('Copy on the Image panel with SVG puts the markup on the clipboard, with the diagram inside by default', async ({ page }) => {
    await importDocument(page);
    const dialog = await openExport(page);
    await dialog.locator('[data-mode="image"]').click();
    // The radios are visually hidden; the pill label is what takes the click (as `sequence-export.spec.ts` does).
    await dialog.locator('[data-value="svg"]').click();
    await expect(dialog.getByRole('checkbox', { name: /Editable/ })).toBeChecked();

    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByText('SVG copied.')).toBeVisible();
    // The dialog stays open: a copy is often the first of several.
    await expect(dialog).toBeVisible();

    const text = await clipboardText(page);
    expect(text.startsWith('<svg')).toBe(true);
    expect(text).toContain('<metadata id="draftcanvas">');
    expect(text).toContain('Order API');

    // Untick Editable: a plain picture.
    await dialog.getByRole('checkbox', { name: /Editable/ }).click();
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByText('SVG copied.')).toBeVisible();
    expect(await clipboardText(page)).not.toContain('<metadata');
  });

  test('Copy on the Source panel copies the architecture source the preview shows', async ({ page }) => {
    await importDocument(page);
    const dialog = await openExport(page);
    await dialog.locator('[data-mode="sequence"]').click();
    await dialog.locator('[data-value="architecture"]').click();
    await dialog.locator('[data-value="mermaid-flowchart"]').click();
    const preview = await dialog.getByTestId('export-source-preview').locator('pre').textContent();

    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByText('Mermaid flowchart source copied.')).toBeVisible();
    const text = await clipboardText(page);
    expect(text).toContain('flowchart LR');
    expect(text).toContain('OrdersDB[("Orders DB")]');
    expect(text.trimEnd()).toBe(preview!.trimEnd());
  });

  test('"Copy as SVG" and "Copy source as…" from the command palette', async ({ page }) => {
    await importDocument(page);
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Commands' });
    await expect(palette).toBeVisible();
    await page.keyboard.type('Copy as SVG');
    await page.keyboard.press('Enter');
    await expect(page.getByText('SVG copied.')).toBeVisible();
    expect((await clipboardText(page)).startsWith('<svg')).toBe(true);

    await page.keyboard.press('ControlOrMeta+k');
    await expect(palette).toBeVisible();
    await page.keyboard.type('Copy source as');
    await page.keyboard.press('Enter');
    await palette.getByText('Structurizr DSL').click();
    await expect(page.getByText('Structurizr DSL source copied.')).toBeVisible();
    expect(await clipboardText(page)).toContain('workspace "Copy Me"');
  });
});
