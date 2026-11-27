import { expect, test, type Page } from '@playwright/test';
import { newCanvas } from './canvas';

/**
 * Linked Junctions: one continuation point drawn in several places, and travelling between them.
 *
 * What a person would notice broken: a counterpart that is not linked when placed, a Go key that
 * goes nowhere or to the wrong place, a camera that does not come back to where it was, a card that
 * will not go away, and a presentation that ends because a Junction was followed.
 */

/**
 * A payment flow in three far-apart places that all continue at A, and a single plain Junction.
 * Far enough apart that no two are on screen together at 100%.
 */
async function seed(page: Page, places: 2 | 3 = 3) {
  await page.evaluate(async (count) => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const { createNode, createEdge } = await import('/src/document/factory.ts');
    const junction = (id: string, x: number, y: number, link?: string) => ({ ...createNode({ id, type: 'ellipse', x, y, text: link ? 'A' : '' }), ...(link ? { link } : {}) });
    const nodes = [
      createNode({ id: 'orders', type: 'service', x: 120, y: 160, text: 'Order Service' }),
      junction('a1', 420, 176, 'pay'),
      createNode({ id: 'execution', type: 'group', x: 5900, y: 2900, width: 760, height: 260, text: 'Payment Execution' }),
      { ...junction('a2', 5960, 3016, 'pay'), parentId: 'execution' },
      { ...createNode({ id: 'adapter', type: 'service', x: 6120, y: 3000, text: 'Partner Adapter' }), parentId: 'execution' },
      ...(count === 3 ? [junction('a3', 300, 5000, 'pay'), createNode({ id: 'recon', type: 'service', x: 460, y: 4984, text: 'Reconciliation' })] : []),
      junction('plain', 120, 420),
    ];
    const edges = [
      createEdge({ id: 'leaves', source: 'orders', target: 'a1' }),
      createEdge({ id: 'arrives', source: 'a2', target: 'adapter' }),
      ...(count === 3 ? [createEdge({ id: 'settles', source: 'a3', target: 'recon' })] : []),
    ];
    useEditorStore.getState().addNodesWithEdges(nodes, edges, 'Seed');
    useEditorStore.getState().setSelection({ nodes: [], edges: [] });
  }, places);
  await expect(page.locator('.react-flow__node')).toHaveCount(places === 3 ? 8 : 6);
}

const shape = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const camera = (page: Page) => page.evaluate(() => (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform);
const undoSteps = (page: Page) => page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().history.past.length);
const trail = (page: Page) => page.getByRole('navigation', { name: 'Junction history' });
const places = (page: Page) => page.getByRole('dialog', { name: /^Where Junction A continues$/ });

test('a counterpart is linked the moment it is placed, and one undo takes both back', async ({ page }) => {
  await newCanvas(page, 'Junction counterpart');
  await seed(page, 2);
  await shape(page, 'plain').click();
  await page.getByRole('toolbar').getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Click where this junction continues' })).toBeVisible();

  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.click(pane.x + 700, pane.y + 520);
  await expect(page.getByText('Junction B now continues in 2 places.')).toBeVisible();
  // Both wear the ring of a Junction that leads somewhere, and read the same.
  await expect(page.locator('.dc-node[data-link="linked"]', { hasText: 'B' })).toHaveCount(2);
  await expect(shape(page, 'plain').locator('.dc-node')).toHaveAttribute('data-link', 'linked');

  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.dc-node[data-link="linked"]', { hasText: 'B' })).toHaveCount(0);
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
  await expect(shape(page, 'plain').locator('.dc-node')).not.toHaveAttribute('data-link', /.*/);
});

test('Escape puts a counterpart in hand away without placing it', async ({ page }) => {
  await newCanvas(page, 'Junction counterpart cancelled');
  await seed(page, 2);
  await shape(page, 'plain').click();
  await page.getByRole('toolbar').getByRole('button', { name: 'Add link', exact: true }).click();
  await expect(page.locator('.dc-canvas')).toHaveAttribute('data-junction-placing', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-canvas')).not.toHaveAttribute('data-junction-placing', 'true');
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.click(pane.x + 700, pane.y + 520);
  await expect(page.locator('.react-flow__node')).toHaveCount(6);
});

test('the Go key travels to where a Junction continues, and Back returns to the exact view', async ({ page }) => {
  await newCanvas(page, 'Junction travel');
  await seed(page, 2);
  const start = await camera(page);
  const steps = await undoSteps(page);
  await expect(shape(page, 'a2')).not.toBeInViewport();

  await shape(page, 'a1').click();
  await page.keyboard.press('g');
  // Arrives with what it leads to, not centred on the circle alone.
  await expect(shape(page, 'a2')).toBeInViewport();
  await expect(shape(page, 'adapter')).toBeInViewport({ ratio: 1 });
  await expect(shape(page, 'a1')).not.toBeInViewport();
  // Nothing is left selected off screen, and nothing was edited.
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  expect(await undoSteps(page)).toBe(steps);

  await expect(trail(page)).toBeVisible();
  await expect(trail(page).getByRole('button', { name: 'Go back to A' })).toBeVisible();
  await page.keyboard.press('Shift+g');
  await expect(shape(page, 'a1')).toBeInViewport();
  await expect.poll(() => camera(page)).toBe(start);

  // Forward again, from the keyboard and then from the bar.
  await page.keyboard.press('Alt+g');
  await expect(shape(page, 'a2')).toBeInViewport();
  await trail(page).getByRole('button', { name: /^Go back to/ }).click();
  await expect(shape(page, 'a1')).toBeInViewport();
  await trail(page).getByRole('button', { name: 'Close junction history' }).click();
  await expect(trail(page)).toHaveCount(0);
  expect(await undoSteps(page)).toBe(steps);
});

test('with several places it shows them, and the keyboard picks one', async ({ page }) => {
  await newCanvas(page, 'Junction places');
  await seed(page, 3);
  await shape(page, 'a1').click();
  await page.keyboard.press('g');

  const card = places(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Continues in 2 places');
  const options = card.getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText('Payment Execution');
  await expect(options.nth(0)).toContainText('continues to Partner Adapter');
  await expect(options.nth(1)).toContainText('continues to Reconciliation');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  // The picture is of the place that is highlighted, drawn by the diagram's own renderer.
  await expect(card.locator('.dc-junction-picture svg')).toBeVisible();
  await expect(card.locator('.dc-junction-picture')).toContainText('Partner Adapter');
  // Nothing has moved yet: which place is the person's choice.
  await expect(shape(page, 'a1')).toBeInViewport();

  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(card.locator('.dc-junction-picture')).toContainText('Reconciliation');
  await page.keyboard.press('Enter');
  await expect(card).toHaveCount(0);
  await expect(shape(page, 'a3')).toBeInViewport();
  await expect(shape(page, 'recon')).toBeInViewport({ ratio: 1 });
});

test('Escape closes the places and leaves the camera where it was', async ({ page }) => {
  await newCanvas(page, 'Junction places dismissed');
  await seed(page, 3);
  const start = await camera(page);
  await shape(page, 'a1').click();
  await page.keyboard.press('g');
  await expect(places(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(places(page)).toHaveCount(0);
  expect(await camera(page)).toBe(start);
  await expect(trail(page)).toHaveCount(0);
});

test('resting the pointer on a linked Junction shows where it continues, and leaving takes it away', async ({ page }) => {
  await newCanvas(page, 'Junction peek');
  await seed(page, 2);
  const box = (await shape(page, 'a1').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const card = places(page);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Continues in one other place');
  await expect(card).toContainText('Payment Execution');
  await expect(card.locator('.dc-junction-picture svg')).toBeVisible();
  // It takes nothing: the Junction is not selected, and the keyboard is still the canvas's.
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

  await page.mouse.move(box.x + 500, box.y + 400);
  await expect(card).toHaveCount(0);

  // A plain Junction, and one still waiting for a counterpart, have nowhere to show.
  const plain = (await shape(page, 'plain').boundingBox())!;
  await page.mouse.move(plain.x + plain.width / 2, plain.y + plain.height / 2);
  await page.waitForTimeout(700);
  await expect(page.locator('.dc-junction-peek')).toHaveCount(0);

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /^Go there/ }).click();
  await expect(shape(page, 'a2')).toBeInViewport();
  await expect(card).toHaveCount(0);
});

test('a presenter follows a Junction with a click, and the presentation carries on', async ({ page }) => {
  await newCanvas(page, 'Junction presenting');
  await seed(page, 2);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
  // The opening overview shows the whole diagram: both Junctions are on screen, small.
  await expect(shape(page, 'a1')).toBeInViewport();
  await shape(page, 'a1').click();
  await expect(shape(page, 'adapter')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
  await expect(trail(page)).toBeVisible();
  // No editing surface came with it.
  await expect(page.locator('.dc-element-inspector')).toHaveCount(0);
  await page.keyboard.press('Shift+g');
  await expect(shape(page, 'a1')).toBeInViewport();
  await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
});

test('the palette finds each place a Junction is drawn, by where it is', async ({ page }) => {
  await newCanvas(page, 'Junction search');
  await seed(page, 3);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('junction a');
  const rows = page.getByRole('option', { name: /Junction A/ });
  await expect(rows).toHaveCount(3);
  await expect(page.getByRole('option', { name: /Junction A.*Payment Execution/ })).toBeVisible();
  await page.getByRole('option', { name: /Junction A.*Payment Execution/ }).click();
  await expect(shape(page, 'adapter')).toBeInViewport({ ratio: 1 });
  await expect(trail(page)).toBeVisible();
});

test('renaming one linked Junction renames it everywhere, and the right-click menu links and unlinks', async ({ page }) => {
  await newCanvas(page, 'Junction rename');
  await seed(page, 2);
  await shape(page, 'a1').dblclick();
  await page.keyboard.type('Pay');
  await page.keyboard.press('Enter');
  await expect(shape(page, 'a1')).toContainText('Pay');
  await expect.poll(() => page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.nodes.filter((node: { link?: string }) => node.link === 'pay').map((node: { text?: string }) => node.text))).toEqual(['Pay', 'Pay']);

  await shape(page, 'a1').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /Follow link/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Unlink' }).click();
  await expect(shape(page, 'a1').locator('.dc-node')).not.toHaveAttribute('data-link', /.*/);
  // The other one is left waiting, not broken: its ring is dashed and it says so to a screen reader.
  await expect(shape(page, 'a2').locator('.dc-node')).toHaveAttribute('data-link', 'waiting');
});
