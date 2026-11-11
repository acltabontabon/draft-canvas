import { expect, test, type Page } from '@playwright/test';
import { newCanvas, nextFrames } from './canvas';

/** Putting a shape into a connector, taking it back out with ⌥⌫, and connecting several at once. */

interface Built {
  [name: string]: string;
}

/** Shapes and connectors built straight into the store, then fitted into view. */
async function build(page: Page, shapes: { name: string; type: string; x: number; y: number }[], links: [string, string][] = []) {
  const ids = await page.evaluate(
    async ({ shapes, links }) => {
      const { useEditorStore } = await import('/src/store/editorStore.ts');
      const store = useEditorStore.getState;
      const ids: Record<string, string> = {};
      for (const shape of shapes) {
        ids[shape.name] = store().addNode({ type: shape.type as 'service', text: shape.name, x: shape.x, y: shape.y }).id;
      }
      for (const [from, to] of links) store().connect(ids[from]!, ids[to]!);
      store().setSelection({ nodes: [], edges: [] });
      return ids;
    },
    { shapes, links },
  );
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+1');
  await nextFrames(page);
  await page.waitForTimeout(400);
  return ids as Built;
}

async function centre(page: Page, id: string) {
  const box = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const links = (page: Page) =>
  page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const { nodes, edges } = useEditorStore.getState().document;
    const name = (id: string) => nodes.find((n: { id: string }) => n.id === id)?.text;
    return edges
      .map((e: { source: string; target: string; semantic?: string; async?: boolean }) => `${name(e.source)}>${name(e.target)}:${e.semantic ?? ''}${e.async ? ':async' : ''}`)
      .sort();
  });

test('a Queue dropped on a connector goes into its middle, and ⌥⌫ takes it back out', async ({ page }) => {
  await newCanvas(page, 'Splice');
  const ids = await build(
    page,
    [
      { name: 'Orders API', type: 'service', x: 0, y: 0 },
      { name: 'Billing', type: 'service', x: 640, y: 0 },
      { name: 'orders', type: 'queue', x: 330, y: 260 },
    ],
    [['Orders API', 'Billing']],
  );
  const from = await centre(page, ids.orders!);
  const left = await centre(page, ids['Orders API']!);
  const right = await centre(page, ids.Billing!);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((left.x + right.x) / 2, left.y, { steps: 16 });
  await expect(page.locator('.dc-edge[data-splice-target="true"]')).toHaveCount(1);
  await page.mouse.up();

  await expect.poll(() => links(page)).toEqual(['Orders API>orders:command:async', 'orders>Billing:consumes:async']);

  await page.locator(`.react-flow__node[data-id="${ids.orders}"]`).click();
  await page.keyboard.press('Alt+Backspace');
  await expect.poll(() => links(page)).toEqual(['Orders API>Billing:calls']);
});

test('dragging from one of several selected shapes connects them all', async ({ page }) => {
  await newCanvas(page, 'Fan-in');
  const ids = await build(page, [
    { name: 'Orders', type: 'service', x: 0, y: 0 },
    { name: 'Billing', type: 'service', x: 0, y: 160 },
    { name: 'Shipping', type: 'service', x: 0, y: 320 },
    { name: 'Store', type: 'database', x: 460, y: 140 },
  ]);
  await page.evaluate(async (selected) => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    useEditorStore.getState().setSelection({ nodes: selected, edges: [] });
  }, [ids.Orders!, ids.Billing!, ids.Shipping!]);
  const source = page.locator(`.react-flow__node[data-id="${ids.Orders}"]`);
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  const target = await centre(page, ids.Store!);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 12 });
  await expect(page.locator('.dc-fan-in-preview line')).toHaveCount(2);
  await page.mouse.up();

  await expect.poll(() => links(page)).toEqual(['Billing>Store:readsWrites', 'Orders>Store:readsWrites', 'Shipping>Store:readsWrites']);
});
