import { expect, test, type Page } from '@playwright/test';

/**
 * Flows: build one from existing connectors, present it, and reuse the same
 * architecture for a second scenario without redrawing anything.
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

/**
 * Shows the Flows panel — the one surface for flows — unless it is already showing. Creating
 * a flow opens the panel on its own (to name it), and the toolbar's "Flows" button is a toggle,
 * so clicking blindly would close it again.
 */
async function openFlowPanel(page: Page) {
  const panel = page.locator('.dc-flow-panel');
  if (!(await panel.isVisible())) await page.getByTitle('Flows (F)').click();
  await expect(panel).toBeVisible();
}

/** Renames the `index`-th flow in the panel the way a user does: double-click the name, type, Enter. */
async function renameFlow(page: Page, index: number, title: string) {
  const row = page.locator('.dc-flow-item').nth(index);
  await row.locator('.dc-flow-title').dblclick();
  const field = page.locator('.dc-flow-title-input');
  await field.fill(title);
  await field.press('Enter');
  await expect(row.locator('.dc-flow-title')).toHaveText(title);
}

async function closeFlowPanel(page: Page) {
  await page.locator('.dc-flow-panel').getByRole('button', { name: 'Close' }).click();
}

async function labelNode(page: Page, index: number, text: string) {
  const node = page.locator('.dc-node').nth(index);
  await node.dblclick();
  const editor = page.locator('.dc-node-editor');
  await expect(editor).toBeVisible();
  await editor.fill(text);
  await editor.press('Enter');
  await expect(editor).toBeHidden();
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

/**
 * Clicks a connector at its own rendered path's true midpoint — not the
 * naive average of its two endpoint nodes' centers, which drifts off the
 * actual (possibly stepped/curved) path whenever the two nodes differ
 * noticeably in height, exactly as a Service (68px tall by default) and a
 * Queue (48px) do. `edgeIndex` is this edge's position in `document.edges`
 * creation order — matching `.dc-edge-line`'s DOM order — not a node index.
 */
async function clickEdgeBetween(page: Page, edgeIndex: number) {
  const path = page.locator('.dc-edge-line').nth(edgeIndex);
  const point = await path.evaluate((el: SVGPathElement) => {
    const len = el.getTotalLength();
    const p = el.getPointAtLength(len / 2);
    const ctm = el.getScreenCTM()!;
    const screenPoint = new DOMPoint(p.x, p.y).matrixTransform(ctm);
    return { x: screenPoint.x, y: screenPoint.y };
  });
  await page.mouse.click(point.x, point.y);
}

/**
 * Selects a connector (by its position in `document.edges` creation order — see
 * `clickEdgeBetween`) and adds it to a flow through the popover's flow chip, whose behaviour
 * follows its `data-flow-state`: with no flows at all (`none`) one click starts a flow with this
 * connector; with an active flow the connector isn't in (`add`) one click appends it; otherwise
 * (`list`) it opens the membership checklist. Starting a new flow lands in the Flows panel's name
 * field — `newTitle` types a name, or Enter keeps the default ("Untitled flow", numbered after).
 */
async function addToFlow(page: Page, edgeIndex: number, existingFlowTitle?: string, newTitle?: string) {
  await clickEdgeBetween(page, edgeIndex);
  const chip = page.locator('[title="Flow membership"]');
  await expect(chip).toBeVisible();
  const state = await chip.getAttribute('data-flow-state');

  if (!existingFlowTitle) {
    if (state === 'none') {
      await chip.click();
    } else {
      // Only the checklist can start a *second* flow from a connector.
      expect(state).toBe('list');
      await chip.click();
      await page.getByRole('button', { name: '+ New flow' }).click();
    }
    const field = page.locator('.dc-flow-title-input');
    await expect(field).toBeFocused();
    if (newTitle) await field.fill(newTitle);
    await field.press('Enter');
    return;
  }

  if (state === 'add' && (await chip.textContent()) === `Add to ${existingFlowTitle}`) {
    await chip.click();
  } else {
    await chip.click();
    // Not `.dc-edge-inspector-panel` — that base class is shared with the connector's own
    // contextual editor; `.dc-edge-inspector-membership` is this checklist's own class.
    await expect(page.locator('.dc-edge-inspector-membership')).toBeVisible();
    const checkbox = page.getByRole('checkbox', { name: existingFlowTitle });
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(checkbox).toBeChecked();
  }
  await expect(chip).toContainText(existingFlowTitle);
}

/**
 * Builds Client -> API -> Payment -> Queue, four nodes and three connectors.
 * The Queue is deliberately left unlabeled: a Queue has no editable name at
 * all (see `DraftNodeView.tsx`'s `beginEditing` — its identity is always just
 * its kind, "Queue"/"Topic"/"Stream"), so there's nothing here to type.
 */
async function buildArchitecture(page: Page) {
  await createNode(page, 'Actor', { x: 150, y: 180 });
  await labelNode(page, 0, 'Client');
  await createNode(page, 'Service', { x: 430, y: 180 });
  await labelNode(page, 1, 'API');
  await createNode(page, 'Service', { x: 710, y: 180 });
  await labelNode(page, 2, 'Payment');
  await createNode(page, 'Queue', { x: 990, y: 180 });

  await connect(page, 0, 1); // Client -> API
  await connect(page, 1, 2); // API -> Payment
  await connect(page, 2, 3); // Payment -> Queue
  await expect(page.locator('.dc-edge-line')).toHaveCount(3);
}

test.describe('Flows', () => {
  test('builds a flow from existing connectors and presents it', async ({ page }) => {
    await newCanvas(page, 'Checkout');
    await buildArchitecture(page);

    // Add all three connectors, in order, to one flow.
    await addToFlow(page, 0);
    await addToFlow(page, 1, 'Untitled flow');
    await addToFlow(page, 2, 'Untitled flow');
    await expect(page.locator('.dc-edge-step')).toHaveCount(3);

    // Rename it in place, in the Flow panel.
    await openFlowPanel(page);
    await renameFlow(page, 0, 'Happy path');
    await expect(page.locator('.dc-flow-item')).toContainText('3 steps');
    await closeFlowPanel(page);

    // Present it — the active flow starts directly, no picker.
    await page.getByTitle('Present (Cmd+Enter)').click();
    await expect(page.locator('.dc-explain')).toBeVisible();
    await expect(page.locator('.dc-explain-flow-title')).toContainText('Happy path');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 3');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 2 / 3');
    await page.keyboard.press('Space');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 3 / 3');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 2 / 3');

    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-explain')).toHaveCount(0);
    await expect(page.locator('.dc-toolbar')).toBeVisible();
  });

  test('the F shortcut opens the panel with focus already inside it, ready to navigate', async ({ page }) => {
    await newCanvas(page, 'Flow panel focus');
    await buildArchitecture(page);
    await addToFlow(page, 0);
    await closeFlowPanel(page);

    await page.keyboard.press('f');
    const panel = page.locator('.dc-flow-panel');
    await expect(panel).toBeVisible();
    const active = await page.evaluate(() => {
      const panel = document.querySelector('.dc-flow-panel');
      return panel?.contains(document.activeElement) ?? false;
    });
    expect(active).toBe(true);

    // No extra Tab needed — arrow keys already move between rows from here.
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.dc-flow-item').first()).toBeFocused();
  });

  test('the F shortcut focuses "New flow" when there are no flows yet', async ({ page }) => {
    await newCanvas(page, 'Flow panel focus — empty');
    await page.keyboard.press('f');
    const panel = page.locator('.dc-flow-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.dc-flow-panel-empty').getByRole('button', { name: 'New flow' })).toBeFocused();
  });

  test('renaming a flow from the Flow panel is a document edit that survives a reload', async ({ page }) => {
    await newCanvas(page, 'Rename persistence');
    await buildArchitecture(page);

    await addToFlow(page, 0);

    await openFlowPanel(page);
    await renameFlow(page, 0, 'Renamed flow');

    // Survives a reload — this is a document edit, not transient UI state.
    // A reload lands back on the library, so re-open the diagram first, and
    // wait for autosave to actually persist before reloading at all.
    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'Rename persistence' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await openFlowPanel(page);
    await expect(page.locator('.dc-flow-item .dc-flow-title')).toHaveText('Renamed flow');
  });

  test('a freshly opened document with one flow shows its step badges immediately', async ({ page }) => {
    await newCanvas(page, 'Fresh open badges');
    await buildArchitecture(page);
    await addToFlow(page, 0);
    await addToFlow(page, 1, 'Untitled flow');
    await expect(page.locator('.dc-edge-step')).toHaveCount(2);

    // Reopening from the library is the "fresh open" this guards — a reload
    // keeps the in-memory store, which would mask a regression here.
    await page.getByTitle('Back to your diagrams').click();
    await page.locator('.dc-library-item', { hasText: 'Fresh open badges' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();

    // No flow selection, no click — badges must already be showing.
    await expect(page.locator('.dc-edge-step')).toHaveCount(2);
  });

  test('reorders and removes steps from the Flow panel', async ({ page }) => {
    await newCanvas(page, 'Reordering');
    await buildArchitecture(page);

    await addToFlow(page, 0);
    await page.getByLabel('Diagram title').click();
    await addToFlow(page, 1, 'Untitled flow');

    await openFlowPanel(page);
    // A freshly created flow is already expanded; only click if it isn't.
    const expand = page.locator('.dc-flow-expand');
    if ((await expand.getAttribute('aria-expanded')) !== 'true') await expand.click();
    const steps = page.locator('.dc-flow-step-row');
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0)).toContainText('Client → API');
    await expect(steps.nth(1)).toContainText('API → Payment');

    // Move the second step earlier.
    await steps.nth(1).getByRole('button', { name: 'Move earlier' }).click();
    await expect(page.locator('.dc-flow-step-row').nth(0)).toContainText('API → Payment');

    // Remove one step.
    await page.locator('.dc-flow-step-row').nth(0).getByRole('button', { name: 'Remove step' }).click();
    await expect(page.locator('.dc-flow-step-row')).toHaveCount(1);
  });

  test('multiple flows reuse the same architecture and diverge independently', async ({ page }) => {
    await newCanvas(page, 'Two scenarios');
    await buildArchitecture(page);
    await openFlowPanel(page);

    // Flow A: Client -> API -> Payment. Named as it is created; the second connector is one
    // click because "Happy path" is now the active flow.
    await addToFlow(page, 0, undefined, 'Happy path');
    await addToFlow(page, 1, 'Happy path');

    // Flow B: shares the first step, then goes straight from API to the queue. Its first
    // connector already belongs to Happy path, so the chip opens the checklist to start it.
    await addToFlow(page, 0, undefined, 'Fast path');
    await addToFlow(page, 2, 'Fast path');

    await expect(page.locator('.dc-flow-item')).toHaveCount(2);
    await expect(page.locator('.dc-flow-item').nth(0)).toContainText('2 steps');
    await expect(page.locator('.dc-flow-item').nth(1)).toContainText('2 steps');

    // Present the second flow explicitly from its own row.
    await page.locator('.dc-flow-item').nth(1).getByRole('button', { name: /^Present/ }).click();
    await expect(page.locator('.dc-explain-flow-title')).toContainText('Fast path');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 2');
  });

  test('marks a connector async (dashed) and gives it a condition chip', async ({ page }) => {
    await newCanvas(page, 'Async and conditions');
    // Two plain, unclassified shapes — not two Services (which now get the opinionated
    // Service→Service editor, whose own Sync/Async choice deliberately never dashes the line —
    // see `connector-semantics.spec.ts`'s "never dashes the primary request line" test), not
    // a service/queue pair (auto-inferred as an EVENT connector, whose dash pattern would take
    // priority over the plain `async` flag this test is actually exercising), and not two
    // Junctions (a routing point, not a component — its connector drops the Flow kind/Condition
    // fields entirely, see `connector-semantics.spec.ts`'s "Junction connector" tests). Two
    // `Text` nodes have no capability-matrix entry at all, so they keep the generic,
    // unrestricted "Flow kind" picker this coupling still applies to.
    await createNode(page, 'Text', { x: 300, y: 250 });
    await createNode(page, 'Text', { x: 700, y: 250 });
    await connect(page, 0, 1);

    await clickEdgeBetween(page, 0);
    // The connector popover's behaviour picker is visible immediately — see
    // `connector-semantics.spec.ts`'s file doc comment.
    // The standalone "Async" toggle was removed as redundant — picking the
    // "Async" kind already sets the flag too (see `setEdgeKind`). Every dropdown in this
    // popover is a custom `InspectorSelect`, not a native `<select>` — see
    // `connector-semantics.spec.ts`'s file doc comment for the click-to-open, click-option
    // interaction pattern.
    await page.getByRole('button', { name: 'Flow kind' }).click();
    await page.getByRole('option', { name: 'Async', exact: true }).click();
    await expect(page.locator('.dc-edge-line')).toHaveCSS('stroke-dasharray', /6.*4/);

    const condition = page.getByLabel('Condition');
    await condition.fill('approved');
    await condition.blur();
    await expect(page.locator('.dc-edge-condition')).toContainText('[approved]');
  });

  test('an old single-walkthrough file migrates into one Flow', async ({ page }) => {
    const legacy = {
      format: 'draft-canvas',
      version: 1,
      metadata: { id: 'd1', title: 'Legacy walkthrough', createdAt: 1, updatedAt: 2 },
      nodes: [
        { id: 'a', type: 'service', x: 0, y: 0, width: 176, height: 68, z: 0, text: 'A' },
        { id: 'b', type: 'service', x: 300, y: 0, width: 176, height: 68, z: 0, text: 'B' },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b', directed: true, routing: 'smoothstep', sequence: 1 },
      ],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { showSequence: true, grid: 'dots' },
    };

    await page.goto('/');
    await page.setInputFiles('input[type="file"]', {
      name: 'legacy.draftcanvas',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(legacy)),
    });
    await expect(page.locator('.dc-editor')).toBeVisible();

    await page.getByTitle('Present (Cmd+Enter)').click();
    await expect(page.locator('.dc-explain')).toBeVisible();
    await expect(page.locator('.dc-explain-flow-title')).toContainText('Walkthrough');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 1');
  });
});
