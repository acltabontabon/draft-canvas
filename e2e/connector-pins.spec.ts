import { expect, test, type Page } from '@playwright/test';
import { afterDropGuard, cameraAtRest, clickEdge, nextFrames } from './canvas';

/**
 * Pinned and automatic connector ends, end to end: drag a shape across to the other side of the
 * shape it is joined to, and the automatic end turns to face it while the pinned one holds.
 */

const node = (id: string, x: number, y: number) => ({ id, type: 'service', x, y, width: 160, height: 80, z: 0, text: id.toUpperCase() });

async function open(page: Page) {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'pins.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'draft-canvas',
      version: 21,
      metadata: { id: 'connector-pins', title: 'Connector pins', createdAt: 1, updatedAt: 2 },
      nodes: [node('a', 600, 0), node('b', 1000, 0), node('c', 1000, 300)],
      edges: [
        // No anchors: both ends automatic.
        { id: 'auto', source: 'a', target: 'b', routing: 'smoothstep', directed: true },
        // Pinned at the start, three quarters down A's right side.
        { id: 'pinned', source: 'a', target: 'c', routing: 'smoothstep', directed: true, sourceAnchor: { side: 'right', offset: 0.75 } },
      ],
      flows: [],
      settings: { grid: 'dots', showSequence: false },
      viewport: { x: 0, y: 0, zoom: 1 },
    })),
  });
  await expect(page.locator('.dc-editor')).toBeVisible();
  await cameraAtRest(page);
}

/** A connector's first point, in screen coordinates. */
async function start(page: Page, id: string) {
  return page.locator(`.react-flow__edge[data-id="${id}"] .dc-edge-hit`).first().evaluate((el) => {
    const path = el as SVGPathElement;
    const point = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
}

const boxOf = async (page: Page, id: string) => (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;

/** The canvas hit path is the exact line export and agent checks read. */
async function expectRouteParity(page: Page, id: string) {
  const expected = await page.evaluate(async (edgeId) => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const { connectorRoutes } = await import('/src/edges/connectorRoutes.ts');
    const { styledConnectorPath } = await import('/src/render/connectorStyle.ts');
    const doc = useEditorStore.getState().document;
    const edge = doc.edges.find((item: { id: string }) => item.id === edgeId);
    const routes = edge && connectorRoutes(edge, doc, 'transient');
    return edge && routes ? styledConnectorPath(routes.request.d, edge) : null;
  }, id);
  expect(await page.locator(`.react-flow__edge[data-id="${id}"] .dc-edge-hit`).first().getAttribute('d')).toBe(expected);
}

test('dragging a shape across turns an automatic end to face it and leaves a pinned end where it was pinned', async ({ page }) => {
  await open(page);
  const a = await boxOf(page, 'a');
  // Before: both leave A's right side.
  expect((await start(page, 'auto')).x).toBeCloseTo(a.x + a.width, 0);
  const pinnedBefore = await start(page, 'pinned');
  expect(pinnedBefore.x).toBeCloseTo(a.x + a.width, 0);
  expect(pinnedBefore.y).toBeCloseTo(a.y + a.height * 0.75, 0);

  // Drag B and C over to A's left. Stay clear of the canvas edge: Firefox auto-pans a drag held near it.
  for (const id of ['b', 'c']) {
    const box = await boxOf(page, id);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 350, box.y + box.height / 2, { steps: 8 });
    await page.mouse.move(box.x + box.width / 2 - 700, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await nextFrames(page);
  }
  await cameraAtRest(page);
  const after = await boxOf(page, 'a');
  // The automatic end now leaves A's left side, facing B.
  expect((await start(page, 'auto')).x).toBeCloseTo(after.x, 0);
  // The pinned end still leaves A's right side, three quarters down, and goes round.
  const pinnedAfter = await start(page, 'pinned');
  expect(pinnedAfter.x).toBeCloseTo(after.x + after.width, 0);
  expect(pinnedAfter.y).toBeCloseTo(after.y + after.height * 0.75, 0);
});

test('a new connector follows its shapes even when drawn between off-centre dots', async ({ page }) => {
  await open(page);
  const source = page.locator('.react-flow__node[data-id="b"]');
  await source.hover();
  const handle = (await source.locator('.dc-handle[data-handleid="top@0"]').boundingBox())!;
  const target = await boxOf(page, 'c');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width * 0.75, target.y + target.height, { steps: 12 });
  await nextFrames(page);
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(3);

  const edgeId = (await page.locator('.react-flow__edge').last().getAttribute('data-id'))!;
  const b = await boxOf(page, 'b');
  // The starting dot was at B's top left, but the new line takes the best side automatically.
  expect((await start(page, edgeId)).y).toBeCloseTo(b.y + b.height, 0);
  await expectRouteParity(page, edgeId);

  const c = await boxOf(page, 'c');
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 - 700, c.y + c.height / 2, { steps: 12 });
  await page.mouse.up();
  await cameraAtRest(page);
  expect((await start(page, edgeId)).x).toBeCloseTo((await boxOf(page, 'b')).x, 0);
  await expectRouteParity(page, edgeId);
});

test('reconnecting an end near a specific dot pins that end', async ({ page }) => {
  await open(page);
  await clickEdge(page, page.locator('.react-flow__edge[data-id="pinned"] .dc-edge-hit').first());
  const endpoint = (await page.locator('.dc-edge-endpoint').first().boundingBox())!;
  const b = await boxOf(page, 'b');
  await page.mouse.move(endpoint.x + endpoint.width / 2, endpoint.y + endpoint.height / 2);
  await page.mouse.down();
  // A few pixels inside B's top edge: a drop is judged against the shape's box, and WebKit rounds
  // a point on the border itself to the outside.
  await page.mouse.move(b.x + b.width * 0.25, b.y + 6, { steps: 12 });
  await page.mouse.up();

  const changed = await page.evaluate(async () => {
    const edge = (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.edges.find((item: { id: string }) => item.id === 'pinned');
    return { source: edge.source, anchor: edge.sourceAnchor };
  });
  expect(changed).toEqual({ source: 'b', anchor: { side: 'top', offset: 0.25 } });
  await expectRouteParity(page, 'pinned');
});

test('Auto attach start lets a pinned end face the shape again, in one undo step', async ({ page }) => {
  await open(page);
  const c = await boxOf(page, 'c');
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 - 700, c.y + c.height / 2, { steps: 10 });
  await page.mouse.up();
  await cameraAtRest(page);
  const a = await boxOf(page, 'a');
  expect((await start(page, 'pinned')).x).toBeCloseTo(a.x + a.width, 0);

  await page.keyboard.press('Escape');
  // A click straight after a drop is eaten by the drag's own guard.
  await afterDropGuard(page);
  await clickEdge(page, page.locator('.react-flow__edge[data-id="pinned"] .dc-edge-hit').first());
  await expect(page.getByRole('toolbar', { name: 'Connector options' })).toBeVisible();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Auto attach start', exact: true }).click();
  await nextFrames(page);
  // Automatic now: it faces C, below and to the left — out of A's bottom side.
  const unpinned = await start(page, 'pinned');
  expect(unpinned.y).toBeCloseTo(a.y + a.height, 0);
  expect(unpinned.x).toBeLessThan(a.x + a.width);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await nextFrames(page);
  expect((await start(page, 'pinned')).x).toBeCloseTo(a.x + a.width, 0);
});


test('manual left-side attachment persists, undoes, and can return to automatic at the center', async ({ page }) => {
  await open(page);
  await clickEdge(page, page.locator('.react-flow__edge[data-id="auto"] .dc-edge-hit').first());
  const endpoint = page.locator('.dc-edge-endpoint').last();
  const b = await boxOf(page, 'b');
  const dragTo = async (x: number, y: number) => {
    const handle = (await endpoint.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    // Start a real drag even when pinning the point currently chosen by automatic routing.
    await page.mouse.move(handle.x + handle.width / 2, handle.y - 30, { steps: 4 });
    await page.mouse.move(x, y, { steps: 12 });
    const targetHandles = page.locator('.react-flow__node[data-id="b"] .dc-handle');
    await expect(targetHandles.first()).toHaveCSS('visibility', 'visible');
    await expect(targetHandles.first()).toHaveCSS('opacity', '1');
    const aimed = page.locator('.react-flow__node[data-id="b"] .dc-handle.connectingto.valid');
    if (x < b.x + b.width / 4) {
      await expect(aimed).toHaveAttribute('data-handleid', 'left@1');
      await expect(aimed).toHaveCSS('width', '14px');
    } else await expect(aimed).toHaveCount(0);
    await page.mouse.up();
    await nextFrames(page);
    await expect(page.locator('.dc-handle.connectingto.valid')).toHaveCount(0);
  };
  const anchor = () => page.evaluate(async () => {
    const edge = (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.edges.find((item: { id: string }) => item.id === 'auto');
    return edge.targetAnchor ?? null;
  });
  await dragTo(b.x + 2, b.y + b.height / 2);
  await expect.poll(anchor).toEqual({ side: 'left', offset: 0.5 });
  await expectRouteParity(page, 'auto');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(anchor).toBeNull();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(anchor).toEqual({ side: 'left', offset: 0.5 });
  await dragTo(b.x + b.width / 2, b.y + b.height / 2);
  await expect.poll(anchor).toBeNull();
  await expectRouteParity(page, 'auto');
});
