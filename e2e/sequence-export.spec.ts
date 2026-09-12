import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Sequence Diagram is a derived EXPORT format, reached from the Export dialog — not a toolbar
 * mode, not an in-app preview. These tests drive the real Export UI against a realistic
 * Saga-style canvas (two flows sharing participants, a Note, a Question, and a structural
 * `dependsOn` edge that must never become a message) imported directly as a document, so the
 * scenario doesn't depend on brittle click-by-click architecture building.
 */

function sagaDocument() {
  const nodes = [
    { id: 'customer', type: 'actor', x: 0, y: 0, width: 96, height: 84, z: 0, text: 'Customer' },
    { id: 'order-api', type: 'service', x: 260, y: 0, width: 176, height: 68, z: 0, text: 'Order API' },
    { id: 'payment-service', type: 'service', x: 520, y: 0, width: 176, height: 68, z: 0, text: 'Payment Service' },
    { id: 'payment-db', type: 'database', x: 780, y: 0, width: 176, height: 68, z: 0, text: 'Payment DB' },
    {
      id: 'retry-note',
      type: 'note',
      noteKind: 'note',
      x: 520,
      y: 200,
      width: 220,
      height: 80,
      z: 0,
      text: 'Retries up to 3 times on timeout',
    },
    {
      id: 'question',
      type: 'note',
      noteKind: 'question',
      x: 260,
      y: 200,
      width: 220,
      height: 80,
      z: 0,
      text: 'Should this retry on failure?',
    },
  ];
  const edges = [
    {
      id: 'e-place-order',
      source: 'customer',
      target: 'order-api',
      label: 'Place Order',
      directed: true,
      routing: 'smoothstep',
      hasResponse: true,
      response: 'Order Confirmed',
    },
    {
      id: 'e-charge-card',
      source: 'order-api',
      target: 'payment-service',
      label: 'Charge Card',
      directed: true,
      routing: 'smoothstep',
      hasResponse: true,
      response: 'Approved',
    },
    {
      id: 'e-save-transaction',
      source: 'payment-service',
      target: 'payment-db',
      label: 'Save Transaction',
      directed: true,
      routing: 'smoothstep',
    },
    {
      id: 'e-release-payment',
      source: 'payment-service',
      target: 'order-api',
      label: 'Release Payment',
      directed: true,
      routing: 'smoothstep',
    },
    {
      id: 'e-depends-on-db',
      source: 'payment-service',
      target: 'payment-db',
      directed: true,
      routing: 'smoothstep',
      semantic: 'dependsOn',
    },
  ];
  const flows = [
    {
      id: 'flow-happy',
      title: 'Happy Path',
      steps: [
        { id: 'hp1', edgeId: 'e-place-order' },
        { id: 'hp2', edgeId: 'e-charge-card', extraNodeIds: ['retry-note'] },
        { id: 'hp3', edgeId: 'e-save-transaction' },
      ],
    },
    {
      id: 'flow-compensation',
      title: 'Compensation',
      steps: [
        { id: 'c1', edgeId: 'e-release-payment', extraNodeIds: ['question'] },
        { id: 'c2', edgeId: 'e-depends-on-db' },
      ],
    },
  ];

  return {
    format: 'draft-canvas',
    version: 10,
    metadata: { id: 'saga-doc', title: 'Payment Saga', createdAt: 1, updatedAt: 2 },
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
    flows,
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
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();
}

/** Export opens on whatever mode was last used (persisted); these tests always want Source. */
async function openSourceExport(page: Page) {
  await openExport(page);
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.locator('[data-mode="sequence"]').click();
  return dialog;
}

test.describe('Sequence Diagram export', () => {
  test('lives inside Export, under Source — no toolbar action, no preview', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');

    // No dedicated toolbar button for it.
    await expect(page.getByTitle('Sequence Diagram')).toHaveCount(0);

    const dialog = await openSourceExport(page);
    await expect(dialog.getByText('Sequence diagram source generated from your Flows.')).toBeVisible();
    // No preview surface anywhere in the dialog.
    await expect(dialog.locator('svg.dc-sequence-svg, .dc-sequence-preview-scroll')).toHaveCount(0);
  });

  test('exports Mermaid source: both flows grouped, the dependsOn edge excluded, notes preserved', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    await openSourceExport(page);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Mermaid' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('payment-saga.mmd');

    const text = readFileSync(await file.path(), 'utf8');
    expect(text).toContain('sequenceDiagram');
    expect(text).toContain('actor Customer');
    expect(text.match(/rect rgb\(240, 240, 240\)/g)).toHaveLength(2);
    expect(text).toContain('Place Order');
    expect(text).toContain('Charge Card');
    expect(text).toContain('Retries up to 3 times on timeout');
    expect(text).toContain('Question: Should this retry on failure?');
    expect(text).toContain('Release Payment');
    // Save Transaction (real) appears once; the dependsOn hop contributes no second arrow.
    expect(text.match(/Save Transaction/g)).toHaveLength(1);
  });

  test('exports PlantUML source when Format is switched', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    const dialog = await openSourceExport(page);

    await dialog.locator('[data-value="plantuml"]').click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PlantUML' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('payment-saga.puml');

    const text = readFileSync(await file.path(), 'utf8');
    expect(text).toContain('@startuml');
    expect(text).toContain('@enduml');
    expect(text).toContain('group Happy Path');
    expect(text).toContain('group Compensation');
    expect(text).toContain('Question: Should this retry on failure?');
  });

  test('shows a disabled card with teaching copy when the diagram has no Flows', async ({ page }) => {
    const doc = sagaDocument();
    doc.flows = [];
    await importDocument(page, doc, 'no-flows.draftcanvas');
    const dialog = await openSourceExport(page);

    await expect(dialog.getByText('Add a Flow to export sequence diagram source.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Export (Mermaid|PlantUML)/ })).toBeDisabled();
  });

  test('has no clipboard actions — file export is the only way out', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    const dialog = await openSourceExport(page);

    await expect(dialog.getByRole('button', { name: 'Copy source' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Copy as Markdown' })).toHaveCount(0);
  });

  test('is fully reachable by keyboard: switch to Source, change format, export, close', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    await page.keyboard.press('Meta+e');
    const dialog = page.getByRole('dialog', { name: 'Export' });
    await expect(dialog).toBeVisible();

    // The mode picker and the Format segmented control are both real `<input type="radio">`
    // groups, so arrow-key navigation is native browser behavior a headless keyDown reliably
    // drives — unlike an OS-native <select> dropdown, which is why this exercises arrow keys
    // directly instead of `.selectOption()`.
    await dialog.getByRole('radio', { name: /Image/ }).focus(); // the default mode
    await page.keyboard.press('ArrowRight'); // Image -> Animated
    await page.keyboard.press('ArrowRight'); // Animated -> Source
    await expect(dialog.getByRole('radio', { name: /Source/ })).toBeChecked();

    // `exact` matters: a substring match would also hit the "Source — Mermaid or PlantUML…" card.
    await dialog.getByRole('radio', { name: 'Mermaid', exact: true }).focus();
    await page.keyboard.press('ArrowRight'); // Mermaid -> PlantUML
    await expect(dialog.getByRole('radio', { name: 'PlantUML', exact: true })).toBeChecked();

    const download = page.waitForEvent('download');
    await page.keyboard.press('Tab'); // Export PlantUML — the only control after Format now
    await expect(page.locator(':focus')).toHaveText('Export PlantUML');
    await page.keyboard.press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toBe('payment-saga.puml');

    // The dialog closes itself on a successful export.
    await expect(page.getByRole('dialog', { name: 'Export' })).toHaveCount(0);
  });

  test('the mode picker is arrow-key navigable', async ({ page }) => {
    await importDocument(page, sagaDocument(), 'saga.draftcanvas');
    await openExport(page);
    const dialog = page.getByRole('dialog', { name: 'Export' });

    await dialog.getByRole('radio', { name: /Document/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: /Image/ })).toBeFocused();
    await expect(dialog.getByRole('radio', { name: /Image/ })).toBeChecked();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(dialog.getByRole('radio', { name: /Source/ })).toBeFocused();
    await expect(dialog.getByRole('radio', { name: /Source/ })).toBeChecked();
  });
});
