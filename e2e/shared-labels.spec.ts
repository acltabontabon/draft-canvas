import { expect, test, type Page } from '@playwright/test';

/**
 * One label for connectors that leave a shape together (`edges/labelGroups.ts`), on the live canvas:
 * drawn once on the run they share, while each connector stays its own thing to hover, select and
 * edit — and editing one never quietly edits the other.
 */

const service = (id: string, x: number, y: number, text: string) => ({ id, type: 'service', x, y, width: 160, height: 80, z: 0, text });

function checkout() {
  return {
    format: 'draft-canvas',
    version: 1,
    metadata: { id: 'shared-labels', title: 'Checkout', createdAt: 1, updatedAt: 2 },
    nodes: [service('pay', 0, 300, 'Checkout'), service('stripe', 640, 60, 'Stripe'), service('adyen', 640, 540, 'Adyen')],
    edges: [
      { id: 'card', source: 'pay', target: 'stripe', directed: true, routing: 'smoothstep', label: 'Pay Credit Card' },
      { id: 'card-2', source: 'pay', target: 'adyen', directed: true, routing: 'smoothstep', label: 'Pay Credit Card' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots' },
  };
}

async function open(page: Page) {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'checkout.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(checkout())),
  });
  await page.waitForSelector('.dc-editor');
  await page.waitForTimeout(700);
}

const labels = (page: Page) => page.locator('.dc-edge-label');
const selectedEdges = (page: Page) =>
  page.locator('.react-flow__edge:has(.dc-edge[data-selected="true"])').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));
const storedLabels = (page: Page) =>
  page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    return useEditorStore.getState().document.edges.map((edge: { label?: string }) => edge.label);
  });

/** A point on a connector's own branch, past where the two part. */
async function branchPoint(page: Page, edgeId: string) {
  return page.locator(`.react-flow__edge[data-id="${edgeId}"] .dc-edge-hit`).first().evaluate((el) => {
    const path = el as SVGPathElement;
    const at = path.getPointAtLength(path.getTotalLength() * 0.8).matrixTransform(path.getScreenCTM()!);
    return { x: at.x, y: at.y };
  });
}

test.describe('a label shared by connectors leaving together', () => {
  test('is drawn once, and each branch is still its own to hover and select', async ({ page }) => {
    await open(page);
    await expect(labels(page)).toHaveCount(1);
    await expect(labels(page)).toHaveText('Pay Credit Card');

    for (const edge of ['card', 'card-2']) {
      const point = await branchPoint(page, edge);
      await page.mouse.move(point.x, point.y);
      await expect(page.locator('.react-flow__edge:has(.dc-edge[data-hovered="true"])')).toHaveAttribute('data-id', edge);
      await page.mouse.click(point.x, point.y);
      expect(await selectedEdges(page)).toEqual([edge]);
      await page.keyboard.press('Escape');
      await page.mouse.click(8, 300);
    }
  });

  test('a click on the shared label picks one connector, and the next click the other', async ({ page }) => {
    await open(page);
    const label = labels(page);
    await label.click();
    expect(await selectedEdges(page)).toEqual(['card']);
    // Hovering it now marks the one the next click takes — the other branch.
    await expect(page.locator('.react-flow__edge:has(.dc-edge[data-hovered="true"])')).toHaveAttribute('data-id', 'card-2');
    await label.click();
    expect(await selectedEdges(page)).toEqual(['card-2']);
    await label.click();
    expect(await selectedEdges(page)).toEqual(['card']);
    // Still one label throughout, now the selected connector's.
    await expect(labels(page)).toHaveCount(1);
  });

  test('editing it edits only the connector it picked, which then keeps a label of its own; undo brings the one label back', async ({ page }) => {
    await open(page);
    await labels(page).dblclick();
    const input = page.getByRole('textbox', { name: 'Connector label' });
    await expect(input).toBeFocused();
    expect(await selectedEdges(page)).toEqual(['card']);
    await input.fill('Pay by Card');
    await input.press('Enter');

    expect(await storedLabels(page)).toEqual(['Pay by Card', 'Pay Credit Card']);
    await expect(labels(page)).toHaveCount(2);
    await expect(labels(page).filter({ hasText: 'Pay by Card' })).toHaveCount(1);
    await expect(labels(page).filter({ hasText: 'Pay Credit Card' })).toHaveCount(1);

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    expect(await storedLabels(page)).toEqual(['Pay Credit Card', 'Pay Credit Card']);
    await expect(labels(page)).toHaveCount(1);
  });

  test('rides the line while its shape is dragged, without splitting', async ({ page }) => {
    await open(page);
    const box = (await page.locator('.react-flow__node[data-id="pay"]').boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(box.x + 40, box.y + 40 + step * 6);
      await expect(labels(page)).toHaveCount(1);
    }
    // Mid-drag the label is still on the (moving) shared line: level with where it leaves the shape.
    const mid = await labels(page).boundingBox();
    const shape = await page.locator('.react-flow__node[data-id="pay"]').boundingBox();
    expect(Math.abs(mid!.y + mid!.height - (shape!.y + shape!.height / 2))).toBeLessThan(14);
    await page.mouse.up();
    await expect(labels(page)).toHaveCount(1);
  });

  test('survives saving and reopening, with every connector keeping its own label in the file', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await page.getByRole('button', { name: /Checkout/ }).first().click();
    await page.waitForSelector('.dc-editor');
    await expect(labels(page)).toHaveCount(1);
    expect(await storedLabels(page)).toEqual(['Pay Credit Card', 'Pay Credit Card']);
  });

  test('shows once in Presentation too', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /^Present/ }).click();
    await expect(page.locator('.dc-editor[data-mode="present"]')).toHaveCount(1);
    await expect(labels(page)).toHaveCount(1);
  });
});
