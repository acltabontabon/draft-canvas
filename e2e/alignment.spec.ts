import { expect, test, type Page } from '@playwright/test';
import { connect, create, newCanvas, nextFrames } from './canvas';

/** Snapping that knows about connectors and spacing, and the selection bar's Same width. */

/** How far the document's one connector is from running straight (`edges/straight.ts`). */
const kink = (page: Page) =>
  page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const { rectOf } = await import('/src/edges/routing.ts');
    const { straightOffset } = await import('/src/edges/straight.ts');
    const { document } = useEditorStore.getState();
    const edge = document.edges[0]!;
    const byId = new Map<string, unknown>(document.nodes.map((node: { id: string }) => [node.id, node]));
    return Math.abs(straightOffset(edge, rectOf(byId.get(edge.source)!), rectOf(byId.get(edge.target)!))?.delta ?? Infinity);
  });

const boxes = (page: Page) =>
  page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    type Box = { x: number; y: number; width: number; height: number };
    return (useEditorStore.getState().document.nodes as Box[]).map(({ x, y, width, height }) => ({ x, y, width, height }));
  });

test.describe('alignment', () => {
  test('a drag snaps a queue onto the straight line through its tube', async ({ page }) => {
    await newCanvas(page, 'Connector snapping');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Queue', { x: 650, y: 250 });
    await connect(page, 0, 1);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    // Placed by their boxes, the tube sits off the service's middle line: a kink, though a small one.
    expect(await kink(page)).toBeGreaterThan(1);
    expect(await kink(page)).toBeLessThan(12);

    const queue = page.locator('.dc-node').nth(1);
    const start = (await queue.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 + 60, start.y + start.height / 2 + 2, { steps: 8 });
    await nextFrames(page);
    await expect(page.locator('.dc-guide[data-kind="connector"]')).toHaveCount(1);
    await page.mouse.up();

    await expect.poll(() => kink(page)).toBeLessThan(0.5);
    await expect(page.locator('.dc-guide')).toHaveCount(0);
  });

  test('a drag shows and snaps to an equal gap', async ({ page }) => {
    await newCanvas(page, 'Spacing snapping');
    await create(page, 'Service', { x: 200, y: 250 });
    await create(page, 'Service', { x: 480, y: 250 });
    await create(page, 'Service', { x: 820, y: 250 });
    const [a, b] = await boxes(page);
    const gap = b!.x - (a!.x + a!.width);

    const mover = page.locator('.dc-node').nth(2);
    const start = (await mover.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2 - 20, start.y + start.height / 2, { steps: 4 });
    await nextFrames(page);
    // Aim a few pixels past an equal gap: close enough to attract.
    const zoom = await page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.viewport.zoom);
    const now = (await mover.boundingBox())!;
    const target = (await page.locator('.dc-node').nth(1).boundingBox())!;
    const wantedLeft = target.x + target.width + gap * zoom + 3;
    await page.mouse.move(start.x + start.width / 2 - 20 + (wantedLeft - now.x), start.y + start.height / 2, { steps: 6 });
    await nextFrames(page);

    const marks = page.locator('.dc-guide[data-kind="gap"]');
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveText(String(Math.round(gap)));
    await page.mouse.up();

    await expect.poll(async () => {
      const [, second, third] = await boxes(page);
      return Math.abs(third!.x - (second!.x + second!.width) - gap);
    }).toBeLessThan(0.5);
  });

  test('Same width in the selection bar gives both shapes the wider width, as one undo step', async ({ page }) => {
    await newCanvas(page, 'Same width');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Queue', { x: 650, y: 250 });
    await page.keyboard.press('ControlOrMeta+A');
    await page.getByRole('button', { name: 'Same width' }).click();
    await expect.poll(async () => new Set((await boxes(page)).map((box) => box.width)).size).toBe(1);
    await page.keyboard.press('ControlOrMeta+Z');
    await expect.poll(async () => new Set((await boxes(page)).map((box) => box.width)).size).toBe(2);
  });
});
