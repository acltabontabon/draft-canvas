import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas } from './canvas';

/**
 * "Tidy up": the gentle cleanup shows what it would do before it does anything, Escape leaves the
 * diagram exactly as it was, and Enter applies it as one undo step.
 */

async function positions(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    return Object.fromEntries(useEditorStore.getState().document.nodes.map((node: { id: string; x: number; y: number }) => [node.id, { x: node.x, y: node.y }]));
  });
}

/** Two connected services, the second a step off level (the router hides a slip of up to about 26
 *  pixels itself, so this is past it), with nothing selected. */
async function offLevel(page: Page) {
  await newCanvas(page, 'Tidy');
  await create(page, 'Service', { x: 240, y: 300 });
  await create(page, 'Service', { x: 620, y: 300 });
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const state = useEditorStore.getState();
    const [a, b] = state.document.nodes as { id: string; x: number; y: number }[];
    state.connect(a!.id, b!.id);
    type Placed = { id: string; x: number; y: number };
    useEditorStore.getState().apply('Nudge', (doc: { nodes: Placed[] }) => ({
      ...doc,
      nodes: doc.nodes.map((node: Placed) => (node.id === b!.id ? { ...node, x: a!.x + 380, y: a!.y + 30 } : node)),
    }));
    useEditorStore.getState().setSelection({ nodes: [], edges: [] });
  });
}

async function runTidy(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
  await page.keyboard.type('Tidy up');
  await expect(page.getByRole('option', { selected: true })).toContainText('Tidy up');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
}

test('previews a cleanup without changing the diagram, and Escape leaves it as it was', async ({ page }) => {
  await offLevel(page);
  const before = await positions(page);

  await runTidy(page);
  const bar = page.getByRole('region', { name: 'Tidy up preview' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('1 shape nudged');
  // The result is drawn over the diagram; the diagram itself has not moved.
  await expect(page.locator('.dc-agent-preview[data-source="tidy"]')).toHaveCount(1);
  expect(await positions(page)).toEqual(before);

  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
  await expect(page.locator('.dc-agent-preview[data-source="tidy"]')).toHaveCount(0);
  expect(await positions(page)).toEqual(before);
});

test('Enter applies the preview as one undo step', async ({ page }) => {
  await offLevel(page);
  const before = await positions(page);

  await runTidy(page);
  const bar = page.getByRole('region', { name: 'Tidy up preview' });
  await expect(bar).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(bar).toBeHidden();

  // Level now: both shapes share a centre line, and only one of them moved.
  const after = await positions(page);
  const moved = Object.keys(before).filter((id) => before[id]!.x !== after[id]!.x || before[id]!.y !== after[id]!.y);
  expect(moved).toHaveLength(1);
  expect(new Set(Object.values(after).map((p) => p.y)).size).toBe(1);

  await page.locator('.react-flow__pane').click({ position: { x: 60, y: 60 } });
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => positions(page)).toEqual(before);

  // Tidy as drawn: a second run says so instead of offering an empty preview.
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => positions(page)).toEqual(after);
  await runTidy(page);
  await expect(page.getByText('Already tidy.')).toBeVisible();
  await expect(bar).toBeHidden();
});
