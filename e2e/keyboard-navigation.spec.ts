import { expect, test, type Page } from '@playwright/test';

/**
 * Alt+Arrow (spatial navigation between nearby elements) and Alt+Shift+Left/Right (relationship
 * navigation along connections) — the keyboard-only counterpart to clicking a node, added because
 * there was previously no way to move the selection to a different element without already having
 * selected something by other means. Bare Arrow (nudge) is unchanged and covered elsewhere
 * (`e2e/editing.spec.ts`); this file is about the new Alt-modified grammar only.
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
  await editor.fill(text);
  await editor.press('Enter');
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

async function selectedText(page: Page) {
  return page.locator('.dc-node[data-selected="true"]').innerText();
}

test.describe('spatial navigation (Alt+Arrow)', () => {
  test('moves the selection in each of the four directions', async ({ page }) => {
    await newCanvas(page, 'Spatial nav — four directions');
    // A cross around a center node, spaced well apart so direction scoring is unambiguous. The
    // center node's own creation point is kept clear of the empty canvas's starter row (roughly
    // x:[430,850] y:[347,508] at this viewport size) — the only node here created while the
    // canvas is still empty and that row is still showing.
    await createNode(page, 'Service', { x: 700, y: 250 });
    await labelNode(page, 0, 'Center');
    await createNode(page, 'Service', { x: 1100, y: 400 });
    await labelNode(page, 1, 'East');
    await createNode(page, 'Service', { x: 300, y: 400 });
    await labelNode(page, 2, 'West');
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
    // Clearly right of true viewport center, and clear of the empty canvas's own starter row
    // (see the four-directions test above for its bounding box) — this is the only node here,
    // created while that row is still showing.
    await createNode(page, 'Service', { x: 1000, y: 360 });
    await labelNode(page, 0, 'Only');

    await page.mouse.click(50, 50); // clear selection
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(0);

    await page.keyboard.press('Alt+ArrowRight');
    await expect.poll(() => selectedText(page)).toBe('Only');
  });

  test('is a no-op when nothing exists in that direction', async ({ page }) => {
    await newCanvas(page, 'Spatial nav — no target');
    // Clear of the empty canvas's own starter row — see the four-directions test above.
    await createNode(page, 'Service', { x: 700, y: 250 });
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
