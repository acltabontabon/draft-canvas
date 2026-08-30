import { expect, test, type Page } from '@playwright/test';

/**
 * Flows: build one from existing connectors, present it, and reuse the same
 * architecture for a second scenario without redrawing anything.
 */

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

async function createNode(page: Page, tool: string, at: { x: number; y: number }) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: at });
}

async function labelNode(page: Page, index: number, text: string) {
  const node = page.locator('.dc-node').nth(index);
  await node.dblclick();
  const editor = page.locator('.dc-node-editor');
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await editor.press('Enter');
  await expect(editor).toBeHidden();
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

async function clickEdgeBetween(page: Page, fromIndex: number, toIndex: number) {
  const from = (await page.locator('.dc-node').nth(fromIndex).boundingBox())!;
  const to = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await page.mouse.click(
    (from.x + from.width + to.x) / 2,
    (from.y + from.height / 2 + to.y + to.height / 2) / 2,
  );
}

async function addToFlow(page: Page, existingFlowTitle?: string) {
  const select = page.getByLabel('Add to flow');
  if (existingFlowTitle) await select.selectOption({ label: existingFlowTitle });
  else await select.selectOption({ label: 'New flow…' });
}

/** Builds Client -> API -> Payment -> Queue, four nodes and three connectors. */
async function buildArchitecture(page: Page) {
  await createNode(page, 'Actor', { x: 150, y: 180 });
  await labelNode(page, 0, 'Client');
  await createNode(page, 'Service', { x: 430, y: 180 });
  await labelNode(page, 1, 'API');
  await createNode(page, 'Service', { x: 710, y: 180 });
  await labelNode(page, 2, 'Payment');
  await createNode(page, 'Queue', { x: 990, y: 180 });
  await labelNode(page, 3, 'orders.v1');

  await connect(page, 0, 1); // Client -> API
  await connect(page, 1, 2); // API -> Payment
  await connect(page, 2, 3); // Payment -> Queue
  await expect(page.locator('.dc-edge-line')).toHaveCount(3);
}

test.describe('Flows', () => {
  test('builds a flow from existing connectors and presents it', async ({ page }) => {
    await newCanvas(page, 'Checkout');
    await buildArchitecture(page);

    // Add all three connectors, in order, to one flow.
    await clickEdgeBetween(page, 0, 1);
    await addToFlow(page);
    await clickEdgeBetween(page, 1, 2);
    await addToFlow(page, 'Untitled flow');
    await clickEdgeBetween(page, 2, 3);
    await addToFlow(page, 'Untitled flow');
    await expect(page.locator('.dc-edge-step')).toHaveCount(3);

    // Rename it from the Flow panel.
    await page.getByTitle('Flows').click();
    const titleField = page.locator('.dc-flow-title-input');
    await titleField.fill('Happy path');
    await titleField.blur();
    await expect(page.locator('.dc-flow-item')).toContainText('3 steps');
    await page.getByTitle('Flows').click();

    // Present it — a single flow starts directly, no picker.
    await page.getByTitle(/^Present/).click();
    await expect(page.locator('.dc-explain')).toBeVisible();
    await expect(page.locator('.dc-explain-flow-title')).toContainText('Happy path');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 3');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 2 / 3');
    await page.keyboard.press('Space');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 3 / 3');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 2 / 3');

    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-explain')).toHaveCount(0);
    await expect(page.locator('.dc-toolbar')).toBeVisible();
  });

  test('renames a flow inline from the Inspector chip, not just the Flow panel', async ({ page }) => {
    await newCanvas(page, 'Inline rename');
    await buildArchitecture(page);

    await clickEdgeBetween(page, 0, 1);
    await addToFlow(page);

    // The chip on the edge's own Inspector row is an editable field, not a
    // static label — renaming from wherever the connector is selected must
    // work, not only from the separate Flow panel.
    const chipInput = page.locator('.dc-inspector-flow-chip-input');
    await chipInput.fill('Renamed from chip');
    await chipInput.blur();

    // The title lives in an input's value, not text content.
    await page.getByTitle('Flows').click();
    await expect(page.locator('.dc-flow-title-input')).toHaveValue('Renamed from chip');

    // Survives a reload — this is a document edit, not transient UI state.
    // A reload lands back on the library, so re-open the diagram first, and
    // wait for autosave to actually persist before reloading at all.
    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'Inline rename' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await page.getByTitle('Flows').click();
    await expect(page.locator('.dc-flow-title-input')).toHaveValue('Renamed from chip');
  });

  test('a freshly opened document with one flow shows its step badges immediately', async ({ page }) => {
    await newCanvas(page, 'Fresh open badges');
    await buildArchitecture(page);
    await clickEdgeBetween(page, 0, 1);
    await addToFlow(page);
    await clickEdgeBetween(page, 1, 2);
    await addToFlow(page, 'Untitled flow');
    await expect(page.locator('.dc-edge-step')).toHaveCount(2);

    // Reopening from the library is the "fresh open" this guards — a reload
    // keeps the in-memory store, which would mask a regression here.
    await page.getByTitle('Back to your diagrams').click();
    await page.locator('.dc-library-item', { hasText: 'Fresh open badges' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();

    // No flow selection, no click — badges must already be showing.
    await expect(page.locator('.dc-edge-step')).toHaveCount(2);
  });

  test('reorders and removes steps from the Flow panel', async ({ page }) => {
    await newCanvas(page, 'Reordering');
    await buildArchitecture(page);

    await clickEdgeBetween(page, 0, 1);
    await addToFlow(page);
    await page.getByLabel('Diagram title').click();
    await clickEdgeBetween(page, 1, 2);
    await addToFlow(page, 'Untitled flow');

    await page.getByTitle('Flows').click();
    await page.locator('.dc-flow-expand').click();
    const steps = page.locator('.dc-flow-step-row');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText('Client → API');
    await expect(steps.nth(1)).toContainText('API → Payment');

    // Move the second step earlier.
    await steps.nth(1).getByRole('button', { name: 'Move earlier' }).click();
    await expect(page.locator('.dc-flow-step-row').nth(0)).toContainText('API → Payment');

    // Remove one step.
    await page.locator('.dc-flow-step-row').nth(0).getByRole('button', { name: 'Remove step' }).click();
    await expect(page.locator('.dc-flow-step-row')).toHaveCount(1);
  });

  test('multiple flows reuse the same architecture and diverge independently', async ({ page }) => {
    await newCanvas(page, 'Two scenarios');
    await buildArchitecture(page);
    await page.getByTitle('Flows').click();

    // Flow A: Client -> API -> Payment.
    await clickEdgeBetween(page, 0, 1);
    await addToFlow(page);
    await page.locator('.dc-flow-title-input').fill('Happy path');
    await page.locator('.dc-flow-title-input').blur();
    await clickEdgeBetween(page, 1, 2);
    await addToFlow(page, 'Happy path');

    // Flow B: shares the first step, then goes straight from API to the queue.
    await clickEdgeBetween(page, 0, 1);
    await page.getByLabel('Add to flow').selectOption({ label: 'New flow…' });
    const titles = page.locator('.dc-flow-title-input');
    await expect(titles).toHaveCount(2);
    await titles.nth(1).fill('Fast path');
    await titles.nth(1).blur();
    await clickEdgeBetween(page, 2, 3);
    await addToFlow(page, 'Fast path');

    await expect(page.locator('.dc-flow-item')).toHaveCount(2);
    await expect(page.locator('.dc-flow-item').nth(0)).toContainText('2 steps');
    await expect(page.locator('.dc-flow-item').nth(1)).toContainText('2 steps');

    // Present the second flow explicitly from its own row (input values are
    // not matched by text locators, so scope by row position instead).
    await page.locator('.dc-flow-item').nth(1).getByRole('button', { name: /^Present/ }).click();
    await expect(page.locator('.dc-explain-flow-title')).toContainText('Fast path');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 2');
  });

  test('marks a connector async (dashed) and gives it a condition chip', async ({ page }) => {
    await newCanvas(page, 'Async and conditions');
    await createNode(page, 'Service', { x: 300, y: 250 });
    await createNode(page, 'Queue', { x: 700, y: 250 });
    await connect(page, 0, 1);

    await clickEdgeBetween(page, 0, 1);
    await page.getByRole('button', { name: 'Async' }).click();
    await expect(page.locator('.dc-edge-line')).toHaveCSS('stroke-dasharray', /6.*4/);

    const condition = page.getByLabel('Condition');
    await condition.fill('approved');
    await condition.blur();
    await expect(page.locator('.dc-edge-condition')).toContainText('[approved]');
  });

  test('an old single-walkthrough file migrates into one Flow', async ({ page }) => {
    const legacy = {
      format: 'draft-canvas',
      version: 1,
      metadata: { id: 'd1', title: 'Legacy walkthrough', createdAt: 1, updatedAt: 2 },
      nodes: [
        { id: 'a', type: 'service', x: 0, y: 0, width: 176, height: 68, z: 0, text: 'A' },
        { id: 'b', type: 'service', x: 300, y: 0, width: 176, height: 68, z: 0, text: 'B' },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep', sequence: 1 },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { showSequence: true, grid: 'dots' },
    };

    await page.goto('/');
    await page.setInputFiles('input[type="file"]', {
      name: 'legacy.draftcanvas',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(legacy)),
    });
    await expect(page.locator('.dc-editor')).toBeVisible();

    await page.getByTitle(/^Present/).click();
    await expect(page.locator('.dc-explain')).toBeVisible();
    await expect(page.locator('.dc-explain-flow-title')).toContainText('Walkthrough');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 1');
  });
});
