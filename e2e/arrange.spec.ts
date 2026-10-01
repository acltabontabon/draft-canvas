import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas } from './canvas';

/** "Arrange diagram": three shapes stacked on one spot come apart, and one ⌘Z puts them back. */

type Box = { x: number; y: number; width: number; height: number };

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

async function nodeBoxes(page: Page): Promise<Box[]> {
  return page.locator('.dc-node').evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
}

async function positions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    return Object.fromEntries(useEditorStore.getState().document.nodes.map((node: { id: string; x: number; y: number }) => [node.id, { x: node.x, y: node.y }]));
  });
}

test('arranges three overlapping shapes apart from the palette, and ⌘Z restores every position', async ({ page }) => {
  await newCanvas(page, 'Arrange');
  await create(page, 'Service', { x: 200, y: 200 });
  await create(page, 'Data Store', { x: 500, y: 200 });
  await create(page, 'Queue', { x: 800, y: 200 });
  await expect(page.locator('.dc-node')).toHaveCount(3);

  // Stacked on one spot through the store, the way the inspector edits — a click on an occupied
  // spot would land on the shape there rather than the pane.
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    type Placed = { x: number; y: number };
    useEditorStore.getState().apply('Stack', (doc: { nodes: Placed[] }) => ({ ...doc, nodes: doc.nodes.map((node: Placed) => ({ ...node, x: 300, y: 300 })) }));
  });
  const stacked = await positions(page);
  expect(new Set(Object.values(stacked).map((p) => `${p.x},${p.y}`)).size).toBe(1);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
  await page.keyboard.type('Arrange diagram');
  await expect(page.getByRole('option', { selected: true })).toContainText('Arrange diagram');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();

  await expect.poll(async () => new Set(Object.values(await positions(page)).map((p) => `${p.x},${p.y}`)).size).toBe(3);
  const boxes = await nodeBoxes(page);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) expect(overlaps(boxes[i]!, boxes[j]!), `shapes ${i} and ${j} overlap`).toBe(false);
  }
  // Every shape is still there, by id.
  expect(Object.keys(await positions(page)).sort()).toEqual(Object.keys(stacked).sort());

  // One undo step puts the stack back exactly.
  await page.locator('.react-flow__pane').click({ position: { x: 60, y: 60 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => positions(page)).toEqual(stacked);
});
