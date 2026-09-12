import { expect, test, type Page } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';

/**
 * The journey the product lives or dies on: build a diagram, trust that it is
 * saved, get it back after a reload, take it out as a file, and put it back.
 *
 * Everything here drives the real UI. Nothing reaches into application state.
 */

const CANVAS = '.react-flow__pane';

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();

  const titleField = page.getByLabel('Diagram title');
  await titleField.fill(title);
  await titleField.blur();
}

/** Creates a node by arming a tool and clicking the canvas. */
async function createNode(page: Page, tool: string, at: { x: number; y: number }) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator(CANVAS).click({ position: at });
}

/**
 * Shows the Flows panel — the one surface for flows — unless it is already showing. Creating
 * a flow opens the panel on its own (to name it), and the toolbar's "Flows" button is a toggle,
 * so clicking blindly would close it again.
 */
async function openFlowPanel(page: Page) {
  const panel = page.locator('.dc-flow-panel');
  if (!(await panel.isVisible())) await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await expect(panel).toBeVisible();
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

async function nodeCount(page: Page) {
  return page.locator('.dc-node').count();
}

/**
 * Clicks a connector at its own rendered path's true midpoint — not the
 * naive average of its two endpoint nodes' centers, which drifts off the
 * actual (possibly stepped/curved) path whenever the two nodes differ
 * noticeably in height. `edgeIndex` is this edge's position in
 * `document.edges` creation order, matching `.dc-edge-line`'s DOM order —
 * not a node index.
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

/** Drags from a node's right-hand handle onto another node. */
async function connect(page: Page, fromIndex: number, toIndex: number) {
  const source = page.locator('.dc-node').nth(fromIndex);
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;

  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
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

test.describe('Draft Canvas', () => {
  test('the diagram survives a reload, an export and a re-import', async ({ page }) => {
    await newCanvas(page, 'Payment Flow');

    /* --- build ---------------------------------------------------------- */

    await createNode(page, 'Service', { x: 260, y: 200 });
    await labelNode(page, 0, 'Service A');

    await createNode(page, 'Service', { x: 700, y: 200 });
    await labelNode(page, 1, 'Service B');

    await createNode(page, 'Data Store', { x: 700, y: 430 });
    await labelNode(page, 2, 'orders');

    expect(await nodeCount(page)).toBe(3);

    /* --- connect Service A to Service B ---------------------------------- */

    await connect(page, 0, 1);
    await expect(page.locator('.dc-edge-line')).toHaveCount(1);

    /* --- label the connection -------------------------------------------- */

    await addToFlow(page, 0);
    await expect(page.locator('.dc-edge-inspector')).toBeVisible();
    // Adding a step selects its flow for overlay, so the step badge appears
    // immediately as feedback.
    await expect(page.locator('.dc-edge-step')).toHaveCount(1);

    /* --- a code card ------------------------------------------------------ */

    await createNode(page, 'Code', { x: 260, y: 470 });
    expect(await nodeCount(page)).toBe(4);
    await expect(page.locator('.dc-node[data-type="code"] tspan').first()).toBeVisible();

    /* --- move, undo, redo -------------------------------------------------- */

    const movable = page.locator('.dc-node').first();
    const before = await movable.boundingBox();
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down();
    await page.mouse.move(before!.x + before!.width / 2 + 130, before!.y + before!.height / 2 + 90, {
      steps: 10,
    });
    await page.mouse.up();

    const moved = await movable.boundingBox();
    expect(Math.abs(moved!.x - before!.x)).toBeGreaterThan(60);

    await page.keyboard.press('Meta+z');
    await expect
      .poll(async () => Math.abs((await movable.boundingBox())!.x - before!.x))
      .toBeLessThan(6);

    await page.keyboard.press('Meta+Shift+z');
    await expect
      .poll(async () => Math.abs((await movable.boundingBox())!.x - moved!.x))
      .toBeLessThan(6);

    /* --- autosave, then reload -------------------------------------------- */

    await expect(page.locator('.dc-save')).toContainText('Saved locally');

    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'Payment Flow' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    expect(await nodeCount(page)).toBe(4);
    await expect(page.locator('.dc-edge-line')).toHaveCount(1);
    await expect(page.getByLabel('Diagram title')).toHaveValue('Payment Flow');

    /* --- export ------------------------------------------------------------ */

    await page.getByTitle(/^Export/).click();
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible();

    const projectDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export document' }).click();
    const projectFile = await projectDownload;
    expect(projectFile.suggestedFilename()).toBe('payment-flow.draftcanvas');

    const projectPath = await projectFile.path();
    expect(existsSync(projectPath)).toBe(true);
    const exported = JSON.parse(readFileSync(projectPath, 'utf8'));
    expect(exported.format).toBe('draft-canvas');
    expect(exported.nodes).toHaveLength(4);
    expect(exported.edges).toHaveLength(1);
    expect(exported.flows).toHaveLength(1);
    expect(exported.flows[0].steps).toHaveLength(1);
    expect(exported.flows[0].steps[0].edgeId).toBe(exported.edges[0].id);

    /* --- PNG and SVG -------------------------------------------------------- */

    await page.getByTitle(/^Export/).click();
    const pngDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PNG' }).click();
    const png = await pngDownload;
    expect(png.suggestedFilename()).toBe('payment-flow.png');
    const pngBytes = readFileSync(await png.path());
    // A real PNG, not an empty or error file.
    expect(pngBytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(pngBytes.byteLength).toBeGreaterThan(2000);

    await page.getByTitle(/^Export/).click();
    const svgDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export SVG' }).click();
    const svg = await svgDownload;
    expect(svg.suggestedFilename()).toBe('payment-flow.svg');
    const svgText = readFileSync(await svg.path(), 'utf8');
    expect(svgText).toContain('<svg');
    expect(svgText).toContain('Service A');
    // Real SVG primitives, so the file renders in a README.
    expect(svgText).not.toContain('foreignObject');

    /* --- animated flow (GIF) ------------------------------------------------- */

    await page.getByTitle(/^Export/).click();
    const gifDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export GIF' }).click();
    const gif = await gifDownload;
    expect(gif.suggestedFilename()).toBe('payment-flow.gif');
    const gifBytes = readFileSync(await gif.path());
    expect(gifBytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(gifBytes.byteLength).toBeGreaterThan(500);

    /* --- delete locally, then import back ----------------------------------- */

    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await expect(page.getByRole('heading', { name: 'Recently edited' })).toBeVisible();

    await page.getByRole('button', { name: /^Delete Payment Flow/ }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    // The last canvas gone is a first run again: the blank canvas and the starters, no empty list.
    await expect(page.getByRole('group', { name: 'Starters', exact: true })).toBeVisible();

    await page.setInputFiles('input[type="file"]', projectPath);
    await expect(page.locator('.dc-editor')).toBeVisible();

    expect(await nodeCount(page)).toBe(4);
    await expect(page.locator('.dc-edge-line')).toHaveCount(1);
    await expect(page.getByLabel('Diagram title')).toHaveValue('Payment Flow');

    // The flow survived the round trip too — not just the raw nodes/edges.
    await openFlowPanel(page);
    await expect(page.locator('.dc-flow-item')).toHaveCount(1);
    await expect(page.locator('.dc-flow-item')).toContainText('1 step');
    await closeFlowPanel(page);

    // And it is editable again, not a read-only import.
    await labelNode(page, 0, 'Service A renamed');
    await expect(page.locator('.dc-save')).toContainText('Saved locally');
  });

  test('no request carries canvas content', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET' || request.postData()) requests.push(request.url());
    });

    await newCanvas(page, 'Private');
    await createNode(page, 'Service', { x: 300, y: 250 });
    await labelNode(page, 0, 'SecretInternalService');
    await expect(page.locator('.dc-save')).toContainText('Saved locally');

    // Nothing is POSTed anywhere, and no GET carries the label either.
    expect(requests).toEqual([]);
  });

  test('walks through ordered steps in a flow', async ({ page }) => {
    await newCanvas(page, 'Walkthrough');

    await createNode(page, 'Service', { x: 240, y: 220 });
    await labelNode(page, 0, 'Client');
    await createNode(page, 'Service', { x: 640, y: 220 });
    await labelNode(page, 1, 'API');
    await createNode(page, 'Data Store', { x: 1040, y: 220 });
    await labelNode(page, 2, 'Store');

    // Connect Client to API, then API to Store, by dragging between them.
    await connect(page, 0, 1);
    await connect(page, 1, 2);
    await expect(page.locator('.dc-edge-line')).toHaveCount(2);

    // Add both connections to one flow, in order.
    await addToFlow(page, 0);
    await addToFlow(page, 1, 'Untitled flow');
    await expect(page.locator('.dc-edge-step')).toHaveCount(2);

    await page.getByRole('button', { name: 'Present', exact: true }).click();
    // The flow just built is the active one, so presentation starts it directly.
    await expect(page.locator('.dc-explain')).toBeVisible();
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 2');
    await expect(page.locator('.dc-canvas[data-explain="on"]')).toBeVisible();
    // Editing chrome is gone while presenting.
    await expect(page.locator('.dc-toolbar')).toHaveCount(0);

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 2 / 2');
    // Step 1 stays visible but subdued now that step 2 is active — not
    // dimmed the same as something outside the walkthrough entirely.
    await expect(page.locator('.dc-edge[data-active="true"]')).toHaveCount(1);
    await expect(page.locator('.dc-edge[data-shown="true"]')).toHaveCount(1);
    await expect(page.locator('.dc-edge[data-dimmed="true"]')).toHaveCount(0);

    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 2');

    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-toolbar')).toBeVisible();
  });

  test('presentation mode shows no editing leftovers: no selection ring, no alignment guides', async ({
    page,
  }) => {
    await newCanvas(page, 'Present mode is read-only chrome');
    await createNode(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);

    await page.getByRole('button', { name: 'Present', exact: true }).click();
    await expect(page.locator('.dc-canvas[data-explain="on"], .react-flow')).toBeVisible();
    // A selection ring from editing has no meaning in a read-only
    // presentation, and no drag-in-progress chrome (guides, attach
    // affordance) can ever be legitimately shown here either.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(0);
    await expect(page.locator('.dc-guide')).toHaveCount(0);
    await expect(page.locator('.dc-attach-affordance')).toHaveCount(0);
  });

  test('Escape exits presentation mode even with no flow playing', async ({ page }) => {
    await newCanvas(page, 'Escape leaves plain present mode');
    await createNode(page, 'Service', { x: 400, y: 300 });

    await page.getByRole('button', { name: 'Present', exact: true }).click();
    await expect(page.locator('.dc-editor[data-mode="present"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-editor[data-mode="edit"]')).toBeVisible();
  });

  test('creates elements from the keyboard and deletes them', async ({ page }) => {
    await newCanvas(page, 'Keyboard');

    await page.locator(CANVAS).hover({ position: { x: 400, y: 300 } });
    await page.keyboard.press('n');
    await expect(page.locator('.dc-node[data-type="note"]')).toHaveCount(1);
    // The new note owns the keyboard until it is committed — the next shortcut must not land in it.
    await expect(page.locator('.dc-node-editor')).toBeFocused();
    await page.keyboard.press('Escape');

    await page.locator(CANVAS).hover({ position: { x: 700, y: 300 } });
    await page.keyboard.press('c');
    await expect(page.locator('.dc-node[data-type="code"]')).toHaveCount(1);
    // Every keyboard-created element opens ready to name, not just a Note.
    await expect(page.locator('.dc-node-editor')).toBeFocused();
    await page.keyboard.press('Escape');

    await page.locator(CANVAS).hover({ position: { x: 400, y: 520 } });
    await page.keyboard.press('s');
    await expect(page.locator('.dc-node[data-type="service"]')).toHaveCount(1);
    await expect(page.locator('.dc-node-editor')).toBeFocused();
    await page.keyboard.press('Escape');

    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.dc-node')).toHaveCount(0);

    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-node')).toHaveCount(3);
  });

  test('the canvas is one Tab stop, not one per node, and shows a focus ring only from real keyboard focus', async ({
    page,
  }) => {
    await newCanvas(page, 'Canvas is one tab stop');
    await createNode(page, 'Service', { x: 400, y: 300 });
    await createNode(page, 'Data Store', { x: 700, y: 300 });

    // Individual nodes are no longer native Tab stops — React Flow's own per-node keyboard
    // handling is turned off (`nodesFocusable={false}`) in favor of `.dc-canvas` being the one
    // Tab stop for the whole diagram.
    const nodeTabIndex = await page
      .locator('.dc-node')
      .first()
      .evaluate((el) => el.closest('.react-flow__node')?.getAttribute('tabindex'));
    expect(nodeTabIndex).toBeNull();

    // Selecting a node with the mouse must not show the keyboard-focus ring.
    await page.locator('.dc-node').first().click();
    const afterMouseClick = await page
      .locator('.dc-node[data-selected="true"]')
      .evaluate((el) => getComputedStyle(el, '::after').boxShadow);
    expect(afterMouseClick).toBe('none');

    // Tabbing onto the canvas does show it — a real, visible keyboard-focus signal, distinct from
    // a plain mouse-selected look.
    await page.evaluate(() => document.body.focus());
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.classList.contains('dc-canvas'))) break;
    }
    await expect(page.locator('.dc-canvas')).toBeFocused();
    await page.locator('.dc-node').first().click();
    const afterKeyboardFocus = await page
      .locator('.dc-node[data-selected="true"]')
      .evaluate((el) => getComputedStyle(el, '::after').boxShadow);
    expect(afterKeyboardFocus).not.toBe('none');
  });

  test('double-clicking empty canvas opens a type picker, and choosing a type creates it', async ({ page }) => {
    await newCanvas(page, 'Quick start');
    await expect(page.getByText('Start drawing.')).toBeVisible();

    // Aim above the empty state's one interactive region, derived from its real bounding box
    // rather than a guessed pixel — the composition moves with the viewport and the curated set,
    // so a hardcoded y here goes stale.
    const paneBox = (await page.locator(CANVAS).boundingBox())!;
    const pickBox = await page.locator('.dc-empty-pick').boundingBox();
    const y = pickBox ? Math.max(24, pickBox.y - paneBox.y - 40) : 320;
    await page.locator(CANVAS).dblclick({ position: { x: 240, y } });
    await expect(page.locator('.dc-node')).toHaveCount(0);
    const menu = page.getByRole('menu', { name: 'Add element' });
    await expect(menu).toBeVisible();

    await menu.getByRole('menuitem', { name: 'Service' }).click();
    await expect(page.locator('.dc-node[data-type="service"]')).toHaveCount(1);
    await expect(page.getByText('Start drawing.')).toBeHidden();
  });
});
