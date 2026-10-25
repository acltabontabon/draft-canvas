import { expect, test, type Page } from '@playwright/test';
import { cameraAtRest, nextFrames } from './canvas';

const node = (id: string, x: number, y: number) => ({ id, type: 'service', x, y, width: 160, height: 80, z: 0, text: id });

async function open(page: Page) {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'connectors.draftcanvas', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'draft-canvas', version: 1,
      metadata: { id: 'connector-tidiness', title: 'Connector tidiness', createdAt: 1, updatedAt: 2 },
      nodes: [node('a', 0, 0), node('b', 600, 0), node('c', 600, 250), node('d', 600, 500)],
      edges: [
        { id: 'edge', source: 'a', target: 'b', routing: 'smoothstep', directed: true, semantic: 'calls', hasResponse: true, response: 'Accepted' },
        { id: 'duplicate', source: 'a', target: 'c', routing: 'smoothstep', directed: true },
      ],
      settings: { grid: 'dots', showSequence: false }, viewport: { x: 0, y: 0, zoom: 1 },
    })),
  });
  await expect(page.locator('.dc-editor')).toBeVisible();
  await cameraAtRest(page);
  const point = await page.locator('.react-flow__edge[data-id="edge"] .dc-edge-hit').first().evaluate((el) => {
    const path = el as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() * 0.65).matrixTransform(path.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole('toolbar', { name: 'Connector options' })).toBeVisible();
}

test('context Async and inspector Sync agree, including response visibility and undo', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Make asynchronous', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Interaction mode' })).toHaveText('Async');
  await expect(page.getByRole('textbox', { name: 'Response', exact: true })).toHaveCount(0);
  await expect(page.locator('.react-flow__edge[data-id="edge"] .dc-edge-response-line')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge[data-id="edge"] .dc-edge-async-marker')).toBeVisible();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Make synchronous', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Add response line', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  // Undo restores selection quietly; click the edge to show its inspector again.
  const path = page.locator('.react-flow__edge[data-id="edge"] .dc-edge-hit').first();
  const point = await path.evaluate((el) => {
    const path = el as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() * 0.65).matrixTransform(path.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByRole('button', { name: 'Interaction mode' })).toHaveText('Sync');
  await expect(page.getByRole('textbox', { name: 'Response', exact: true })).toHaveValue('Accepted');
  await expect(page.getByRole('button', { name: 'Hide reply', exact: true })).toBeVisible();
  await expect(page.locator('.react-flow__edge[data-id="edge"] .dc-edge-response-line')).toHaveCount(1);
  await page.getByRole('button', { name: 'Interaction mode' }).click();
  await page.getByRole('option', { name: 'Async', exact: true }).click();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Make synchronous', exact: true })).toBeVisible();
});

test('duplicate reconnect gives feedback without advertising a valid target or adding history', async ({ page }) => {
  await open(page);
  const path = page.locator('.react-flow__edge[data-id="edge"] .dc-edge-hit').first();
  const before = await path.getAttribute('d');
  const start = (await page.locator('.dc-edge-endpoint').last().boundingBox())!;
  const target = (await page.locator('.react-flow__node[data-id="c"]').boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await nextFrames(page);
  await expect(page.locator('.dc-node[data-reconnect-target="true"]')).toHaveCount(0);
  await expect(page.locator('.dc-handle[data-armed="true"]')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByText('Already connected to that shape.', { exact: true })).toBeVisible();
  await expect(path).toHaveAttribute('d', before!);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('a zoomed-out endpoint can be grabbed beyond its dot', async ({ page }) => {
  await open(page);
  const zoom = () => page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  for (let i = 0; i < 16 && await zoom() > 0.28; i += 1) {
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await cameraAtRest(page);
  }
  expect(await zoom()).toBeLessThan(0.3);
  const endpoint = page.locator('.dc-edge-endpoint').last();
  const hit = await endpoint.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const dot = Number.parseFloat(getComputedStyle(el).width);
    return Number.parseFloat(getComputedStyle(el, '::before').width) * box.width / dot;
  });
  expect(hit).toBeGreaterThanOrEqual(19);
  const start = (await endpoint.boundingBox())!;
  const target = (await page.locator('.react-flow__node[data-id="d"]').boundingBox())!;
  const path = page.locator('.react-flow__edge[data-id="edge"] .dc-edge-hit').first();
  const before = await path.getAttribute('d');
  await page.mouse.move(start.x + start.width / 2 + 8, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(path).not.toHaveAttribute('d', before!);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.dc-edge')).toHaveCount(2);
});
