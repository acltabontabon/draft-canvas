import { expect, test, type Page } from '@playwright/test';
import { armTool, clickEdge, connect as connectShapes, create, newCanvas, nextFrames } from './canvas';

/**
 * Alt+Arrow (spatial navigation between nearby elements) and Alt+Shift+Left/Right (relationship
 * navigation along connections) — the keyboard-only counterpart to clicking a node, added because
 * there was previously no way to move the selection to a different element without already having
 * selected something by other means. Bare Arrow (nudge) is unchanged and covered elsewhere
 * (`e2e/editing.spec.ts`); this file is about the new Alt-modified grammar only.
 */

/**
 * The blank canvas's starter block is the one part of its empty state that takes clicks, so a node
 * placed on a starter while the canvas is still empty would open that architecture instead of
 * creating anything. Arming a tool hands the whole canvas back to drawing, so this asks the page
 * what would actually receive the click only once the tool is armed — checking before arming
 * failed on any point the starter block happened to cover, though the click itself never lands
 * there. The layer on its way out has already stopped taking pointer events.
 */
async function createNode(page: Page, tool: string, at: { x: number; y: number }) {
  await armTool(page, tool);
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  const blocked = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('.dc-empty')?.className ?? null,
    [pane.x + at.x, pane.y + at.y],
  );
  expect(blocked, `(${at.x}, ${at.y}) lands on the blank canvas's empty state — move it clear`).toBeNull();
  await page.locator('.react-flow__pane').click({ position: at });
}

async function labelNode(page: Page, index: number, text: string) {
  const node = page.locator('.dc-node').nth(index);
  await node.dblclick();
  const editor = page.locator('.dc-node-editor');
  await editor.fill(text);
  await editor.press('Enter');
}

async function connect(page: Page, fromIndex: number, toIndex: number) {
  const source = page.locator('.dc-node').nth(fromIndex);
  await page.mouse.move(1, 1); // WebKit refreshes hover only on real movement (see e2e/canvas.ts)
  await source.hover();
  // A handle turns visible only a frame after its node is hovered (a `visibility` transition), and
  // until then a press on it falls through to whatever is beneath — here, the connector already
  // leaving this handle, so the drag never starts a second one. `hover()` waits until the handle
  // itself takes the pointer.
  await source.locator('.dc-handle').nth(1).hover();
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await nextFrames(page);
  await page.mouse.up();
}

async function selectedText(page: Page) {
  return page.locator('.dc-node[data-selected="true"]').innerText();
}

test.describe('spatial navigation (Alt+Arrow)', () => {
  test('moves the selection in each of the four directions', async ({ page }) => {
    await newCanvas(page, 'Spatial nav — four directions');
    // A cross around a center node, spaced well apart so direction scoring is unambiguous.
    await createNode(page, 'Service', { x: 300, y: 400 });
    await labelNode(page, 0, 'West');
    await createNode(page, 'Service', { x: 700, y: 250 });
    await labelNode(page, 1, 'Center');
    await createNode(page, 'Service', { x: 1100, y: 400 });
    await labelNode(page, 2, 'East');
    await createNode(page, 'Service', { x: 700, y: 600 });
    await labelNode(page, 3, 'South');
    await createNode(page, 'Service', { x: 700, y: 100 });
    await labelNode(page, 4, 'North');

    // Re-fit before each re-selection of Center: navigating pans the viewport to reveal whatever
    // was just selected (see `selectAndReveal` in `EditorScreen.tsx`), which can otherwise leave
    // Center panned up behind the toolbar by the time the next direction is checked.
    await page.keyboard.press('Shift+1');
    await page.locator('.dc-node').filter({ hasText: 'Center' }).click();
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => selectedText(page)).toBe('East');

    await page.keyboard.press('Shift+1');
    await page.locator('.dc-node').filter({ hasText: 'Center' }).click();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect.poll(() => selectedText(page)).toBe('West');

    await page.keyboard.press('Shift+1');
    await page.locator('.dc-node').filter({ hasText: 'Center' }).click();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => selectedText(page)).toBe('South');

    await page.keyboard.press('Shift+1');
    await page.locator('.dc-node').filter({ hasText: 'Center' }).click();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => selectedText(page)).toBe('North');
  });

  test('with nothing selected, navigates from the viewport center', async ({ page }) => {
    await newCanvas(page, 'Spatial nav — no prior selection');
    // Clearly right of true viewport center, and right of the blank canvas's starter block —
    // this is the only node here, so it is created while that block is still showing.
    await createNode(page, 'Service', { x: 1140, y: 300 });
    await labelNode(page, 0, 'Only');

    const canvas = await page.locator('.react-flow__pane').boundingBox();
    await page.mouse.click(canvas!.x + 30, canvas!.y + 30);
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(0);

    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => selectedText(page)).toBe('Only');
  });

  test('is a no-op when nothing exists in that direction', async ({ page }) => {
    await newCanvas(page, 'Spatial nav — no target');
    // Left of the blank canvas's starter block — the only node here, so it is created while that
    // block is still showing.
    await createNode(page, 'Service', { x: 300, y: 250 });
    await labelNode(page, 0, 'Alone');

    await page.locator('.dc-node').filter({ hasText: 'Alone' }).click();
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => selectedText(page)).toBe('Alone');
  });

  test('pans the viewport to reveal a target that is off screen', async ({ page }) => {
    await newCanvas(page, 'Spatial nav — pans into view');
    await createNode(page, 'Service', { x: 400, y: 250 });
    await labelNode(page, 0, 'Near');
    await createNode(page, 'Service', { x: 700, y: 400 });
    await labelNode(page, 1, 'Far');

    // Placed in document/flow space directly (a click-to-create can only reach on-screen points) —
    // far enough right, at the current default zoom, to render outside the viewport.
    await page.evaluate(async () => {
      const mod = await import('/src/store/editorStore.ts');
      const state = mod.useEditorStore.getState();
      const target = state.document.nodes.find((n: { text?: string }) => n.text === 'Far');
      state.updateNodeById(target.id, { x: 6000 });
    });

    await expect(page.locator('.dc-node').filter({ hasText: 'Far' })).not.toBeInViewport();
    await page.locator('.dc-node').filter({ hasText: 'Near' }).click();
    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => selectedText(page)).toBe('Far');
    await expect(page.locator('.dc-node').filter({ hasText: 'Far' })).toBeInViewport();
  });

  test('does nothing while editing a node label', async ({ page }) => {
    await newCanvas(page, 'Spatial nav — text editing safety');
    await createNode(page, 'Service', { x: 400, y: 250 });
    await labelNode(page, 0, 'Left');
    await createNode(page, 'Service', { x: 800, y: 400 });

    const node = page.locator('.dc-node').filter({ hasText: 'Left' });
    await node.dblclick();
    const editor = page.locator('.dc-node-editor');
    await expect(editor).toBeVisible();
    await page.keyboard.press('Alt+ArrowRight');
    // Still editing the same node — Alt+Right must not have moved the selection or exited editing.
    await expect(editor).toBeVisible();
    await expect(editor).toBeFocused();
  });
});

test.describe('relationship navigation (Alt+Shift+Left/Right)', () => {
  test('cycles through outgoing neighbors on repeated presses, and back on the first', async ({ page }) => {
    await newCanvas(page, 'Relationship nav — cycling');
    await createNode(page, 'Service', { x: 300, y: 400 });
    await labelNode(page, 0, 'Source');
    await createNode(page, 'Service', { x: 700, y: 200 });
    await labelNode(page, 1, 'First');
    await createNode(page, 'Service', { x: 700, y: 600 });
    await labelNode(page, 2, 'Second');
    await connect(page, 0, 1);
    // Dismisses whatever the first connection auto-opened (its inspector popover) — without this,
    // it can intercept the second drag from the same source node's handle.
    await page.keyboard.press('Escape');
    await connect(page, 0, 2);
    await page.keyboard.press('Escape');

    await page.locator('.dc-node').filter({ hasText: 'Source' }).click();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    const first = await selectedText(page);
    expect(['First', 'Second']).toContain(first);

    await page.keyboard.press('Alt+Shift+ArrowRight');
    const second = await selectedText(page);
    expect(['First', 'Second']).toContain(second);
    expect(second).not.toBe(first);

    // A third press wraps back to the first neighbor.
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(() => selectedText(page)).toBe(first);
  });

  test('Left follows incoming edges, walking back the way Right came', async ({ page }) => {
    await newCanvas(page, 'Relationship nav — walk back');
    await createNode(page, 'Actor', { x: 300, y: 400 });
    await labelNode(page, 0, 'Client');
    await createNode(page, 'Service', { x: 700, y: 400 });
    await labelNode(page, 1, 'API');
    await connect(page, 0, 1);

    await page.locator('.dc-node').filter({ hasText: 'Client' }).click();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(() => selectedText(page)).toBe('API');

    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await expect.poll(() => selectedText(page)).toBe('Client');
  });

  test('is a no-op with no matching neighbor, and requires a single selected node', async ({ page }) => {
    await newCanvas(page, 'Relationship nav — no-ops');
    await createNode(page, 'Service', { x: 300, y: 400 });
    await labelNode(page, 0, 'Lonely');
    await createNode(page, 'Service', { x: 700, y: 400 });
    await labelNode(page, 1, 'Other');

    await page.locator('.dc-node').filter({ hasText: 'Lonely' }).click();
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(() => selectedText(page)).toBe('Lonely');

    // Multi-selection: also a no-op, not an error.
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
  });
});

/**
 * Where keyboard focus goes when the thing holding it closes, and which layer a key belongs to. The
 * canvas (`.dc-canvas`) is the diagram's one Tab stop: a surface that unmounts with focus inside it
 * hands focus back there, as the Outline and Appearance do, rather than dropping it on `<body>`,
 * where a screen reader loses its place and the next Tab starts from wherever the removed control
 * sat. And a key pressed in chrome reached from the keyboard is that control's, never the canvas's.
 */
test.describe('keyboard focus around the canvas', () => {
  const canvas = (page: Page) => page.locator('.dc-canvas');
  const selectedNodes = (page: Page) => page.locator('.dc-node[data-selected="true"]');
  const depth = (page: Page) =>
    page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().path.length);

  test('Backspace and Delete on chrome reached by keyboard leave the canvas selection alone', async ({ page }) => {
    await newCanvas(page, 'Stray delete');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Queue', { x: 650, y: 300 });
    await expect(selectedNodes(page)).toHaveCount(1);

    // Back from the canvas onto the header's last control, the way a keyboard gets there.
    await canvas(page).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeFocused();
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await expect(page.locator('.dc-node')).toHaveCount(2);

    // The History popover owns its keys too, however it was opened.
    await page.locator('.dc-node').first().click();
    await page.locator('.dc-history-chip').click();
    const history = page.getByRole('dialog', { name: 'History' });
    await expect(history).toBeVisible();
    await expect.poll(() => history.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Delete');
    await page.keyboard.press('s');
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });

  test('Escape in the History popover closes only the popover', async ({ page }) => {
    await newCanvas(page, 'History escape');
    await create(page, 'Service', { x: 300, y: 300 });
    await expect(selectedNodes(page)).toHaveCount(1);
    const chip = page.locator('.dc-history-chip');
    const history = page.getByRole('dialog', { name: 'History' });

    await chip.click();
    await expect(history).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(history).toBeHidden();
    await expect(chip).toBeFocused();
    await expect(selectedNodes(page)).toHaveCount(1);

    // Inside a shape with nothing selected, the same Escape would otherwise back out of the room.
    await page.keyboard.press('ControlOrMeta+ArrowDown');
    await expect.poll(() => depth(page)).toBe(1);
    await page.locator('.react-flow__pane').click({ position: { x: 600, y: 500 } });
    await expect(selectedNodes(page)).toHaveCount(0);
    await chip.click();
    await expect(history).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(history).toBeHidden();
    await page.waitForTimeout(400);
    expect(await depth(page)).toBe(1);
  });

  test('finishing a name from the keyboard puts focus back on the canvas', async ({ page }) => {
    await newCanvas(page, 'Name focus');
    await create(page, 'Service', { x: 400, y: 300 });
    await canvas(page).focus();
    const editor = page.locator('.dc-node-editor');

    await page.keyboard.press('Enter');
    await expect(editor).toBeFocused();
    await page.keyboard.type('Orders');
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(canvas(page)).toBeFocused();
    // Escape still reverts a name: handing focus back must not commit what was typed.
    await expect(page.locator('.dc-node').first()).not.toContainText('Orders');

    await page.keyboard.press('Enter');
    await page.keyboard.type('Orders API');
    await page.keyboard.press('Enter');
    await expect(editor).toHaveCount(0);
    await expect(canvas(page)).toBeFocused();
    await expect(page.locator('.dc-node').first()).toContainText('Orders API');
    await expect(selectedNodes(page)).toHaveCount(1);
  });

  test('a shape toolbar closed from the keyboard puts focus back on the canvas', async ({ page }) => {
    await newCanvas(page, 'Toolbar focus');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Queue', { x: 650, y: 300 });
    const toolbar = page.getByRole('toolbar', { name: 'Element options' });
    await expect(toolbar).toBeVisible();

    // Escape inside the toolbar deselects, and the toolbar that held focus goes with the selection.
    await canvas(page).focus();
    await page.keyboard.press('Tab');
    await expect(toolbar.getByRole('button', { name: 'Element colour' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(selectedNodes(page)).toHaveCount(0);
    await expect(canvas(page)).toBeFocused();

    // Its Delete button, pressed from the keyboard, removes the shape the toolbar was about.
    await page.locator('.dc-node').first().click();
    await expect(toolbar).toBeVisible();
    const remove = toolbar.getByRole('button', { name: 'Delete', exact: true });
    await canvas(page).focus();
    for (let i = 0; i < 12 && !(await remove.evaluate((el) => el === document.activeElement)); i += 1) {
      await page.keyboard.press('Tab');
    }
    await expect(remove).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node')).toHaveCount(1);
    await expect(canvas(page)).toBeFocused();
  });

  /** A Service sending to a Queue, its connector's toolbar open: a connector whose caption chip is its
   *  name (a request/response pairing shows its operation editor there instead). */
  async function connectorToolbar(page: Page, title: string) {
    await newCanvas(page, title);
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Queue', { x: 700, y: 300 });
    await connectShapes(page, 0, 1);
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
    await clickEdge(page, page.locator('.dc-edge[data-selected="true"] .dc-edge-line'));
    const toolbar = page.getByRole('toolbar', { name: 'Connector options' });
    await expect(toolbar).toBeVisible();
    return toolbar;
  }

  test('the connector toolbar’s label field hands focus back to the chip that opened it', async ({ page }) => {
    const toolbar = await connectorToolbar(page, 'Connector label focus');
    const caption = toolbar.locator('.dc-edge-inspector-caption');
    await caption.focus();
    await page.keyboard.press('Enter');
    const field = toolbar.getByRole('textbox', { name: 'Connector label' });
    await expect(field).toBeFocused();
    await page.keyboard.type('pays');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(caption).toBeFocused();
    await expect(caption).not.toHaveText('pays');
    await page.keyboard.press('Enter');
    await page.keyboard.type('pays');
    await page.keyboard.press('Enter');
    await expect(field).toHaveCount(0);
    await expect(caption).toBeFocused();
    await expect(caption).toHaveText('pays');
  });

  test('Escape on the connector colour flyout closes the flyout alone', async ({ page }) => {
    // As the shape toolbar's colour panel does: the connector stays selected, its toolbar open.
    const toolbar = await connectorToolbar(page, 'Connector colour flyout');
    const swatch = toolbar.getByRole('button', { name: 'Connector colour' });
    await swatch.focus();
    await page.keyboard.press('Enter');
    const flyout = toolbar.locator('.dc-connector-palette-flyout');
    await expect(flyout).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(flyout).toHaveCount(0);
    await expect(toolbar).toBeVisible();
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
    await expect(swatch).toBeFocused();
    // A second Escape is the canvas's again: it deselects, and focus lands on the canvas.
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(0);
    await expect(canvas(page)).toBeFocused();
  });

  test('connectors are not Tab stops: the canvas is the one stop for the whole diagram', async ({ page }) => {
    await newCanvas(page, 'Connector tab stops');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Service', { x: 700, y: 300 });
    await connectShapes(page, 0, 1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(0);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect(page.locator('.react-flow__edge[tabindex]')).toHaveCount(0);
    // Still named for a screen reader, as an image of the relationship it draws.
    await expect(page.locator('.react-flow__edge')).toHaveAttribute('aria-label', /.+/);

    await canvas(page).focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('.react-flow__renderer') ?? null)).toBeNull();
  });
});
