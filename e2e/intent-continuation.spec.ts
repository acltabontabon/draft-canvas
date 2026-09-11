import { expect, test, type Page } from '@playwright/test';

/**
 * Intent Continuation, driven through the real UI: the ghost that appears beside a node with an
 * obvious next move, Tab/click/Escape on it, one-step undo, and the continuation-aware Quick
 * Connect picker a connector dropped on empty canvas opens. Domain rules themselves are
 * table-tested in `tests/continuation.test.ts`; this covers the interaction.
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

async function create(page: Page, tool: string, at: { x: number; y: number }) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator(CANVAS).click({ position: at });
}

function inspectorSelect(page: Page, ariaLabel: string) {
  return page.getByRole('button', { name: ariaLabel });
}

async function chooseInspectorOption(page: Page, ariaLabel: string, optionLabel: string) {
  await inspectorSelect(page, ariaLabel).click();
  await page.getByRole('option', { name: optionLabel, exact: true }).click();
}

/** Drags from a node's right-hand handle to a screen point (another node's centre, or empty canvas). */
async function dragHandleTo(page: Page, fromIndex: number, to: { x: number; y: number }) {
  const source = page.locator('.dc-node').nth(fromIndex);
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}

async function connect(page: Page, fromIndex: number, toIndex: number) {
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await dragHandleTo(page, fromIndex, { x: target.x + target.width / 2, y: target.y + target.height / 2 });
}

/** Service → Topic, with the Topic left selected: the state every ghost test starts from. */
async function publisherAndTopic(page: Page) {
  await create(page, 'Service', { x: 200, y: 300 });
  await create(page, 'Queue', { x: 520, y: 300 });
  await chooseInspectorOption(page, 'Queue type', 'Topic');
  await connect(page, 0, 1);
  // The fresh connector is selected and its popover sits over the Topic; clear it first.
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-edge-inspector')).toHaveCount(0);
  await page.locator('.dc-node').nth(1).click();
}

const captions = (page: Page) => page.locator('.dc-edge text');

test.describe('Intent Continuation', () => {
  test('a Topic with a publisher offers a Queue; Tab adds it, then a Worker; undo takes one step back', async ({ page }) => {
    await newCanvas(page, 'Continuation chain');
    await publisherAndTopic(page);

    const ghost = page.locator('.dc-ghost');
    await expect(ghost).toHaveAttribute('data-trigger', 'select');
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'queue');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('fans out');
    await expect(page.locator('.dc-ghost-pill')).toContainText('Queue');

    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(captions(page)).toContainText(['publishes', 'fans out']);
    // The new Queue is selected and, having no consumer, offers a Worker next.
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'service');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('consumes');

    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(4);
    await expect(captions(page)).toContainText(['publishes', 'fans out', 'consumes']);
    // A plain Worker has no single obvious next move: silence.
    await expect(ghost).toHaveCount(0);

    // One undo removes the Worker and its connector together.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(page.locator('.dc-edge')).toHaveCount(2);
  });

  test('resizing the anchor keeps it selected and the ghost reappears with the same suggestion', async ({ page }) => {
    await newCanvas(page, 'Continuation resize');
    await publisherAndTopic(page);
    await expect(page.locator('.dc-ghost')).toHaveCount(1);

    // A real interaction gesture on the anchor itself (distinct from a plain document write) —
    // the ghost is expected to hide for the duration (see `interactionActive`) and must reappear,
    // correctly, once the gesture settles, rather than getting orphaned or stuck hidden.
    const handle = (await page.locator('.dc-resize-handle').nth(3).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 30, handle.y + 20, { steps: 8 });
    await page.mouse.up();

    // Still the same one node selected (the resize did not steal or drop selection) and the same
    // suggestion is showing, not a stale or broken one.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'queue');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('fans out');

    // And it is functionally intact, not just visually present.
    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(captions(page)).toContainText(['publishes', 'fans out']);
  });

  test("the ghost node's mount-in animation lives on its inner body, never on the positioned outer element", async ({ page }) => {
    // A CSS animation replaces the whole `transform` property for its duration — if the mount-in
    // scale/fade animation and the positioning `transform: translate(...)` ever landed on the same
    // element, the ghost would render at the canvas origin for the animation's length instead of
    // next to its anchor. Checked structurally (which element the animation is actually on) rather
    // than by racing the 120ms window, which would be flaky either way this could fail.
    await newCanvas(page, 'Continuation mount position');
    await publisherAndTopic(page);
    const ghostNode = page.locator('.dc-ghost-node');
    await expect(ghostNode).toHaveCount(1);
    const { outerAnimation, bodyAnimation } = await ghostNode.evaluate((el) => ({
      outerAnimation: getComputedStyle(el).animationName,
      bodyAnimation: getComputedStyle(el.querySelector('.dc-ghost-node-body')!).animationName,
    }));
    expect(outerAnimation).toBe('none');
    expect(bodyAnimation).toBe('dc-attachment-card-in');
  });

  test('clicking the ghost accepts it too', async ({ page }) => {
    await newCanvas(page, 'Continuation click');
    await publisherAndTopic(page);
    await page.locator('.dc-ghost-pill').click();
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(captions(page)).toContainText(['publishes', 'fans out']);
  });

  test('Escape waves a ghost away without touching the diagram, and it stays away on reselect', async ({ page }) => {
    await newCanvas(page, 'Continuation dismiss');
    await publisherAndTopic(page);
    await expect(page.locator('.dc-ghost')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-ghost')).toHaveCount(0);
    await expect(page.locator('.dc-node')).toHaveCount(2);
    // The selection it was offered for is untouched.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);

    await page.locator(CANVAS).click({ position: { x: 700, y: 600 } });
    await page.locator('.dc-node').nth(1).click();
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
    await expect(page.locator('.dc-ghost')).toHaveCount(0);
  });

  test('Tab from a toolbar control is ordinary focus traversal, never an accept', async ({ page }) => {
    await newCanvas(page, 'Continuation focus');
    await publisherAndTopic(page);
    await expect(page.locator('.dc-ghost')).toHaveCount(1);
    await page.getByRole('button', { name: 'Select', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });

  test('a finished shape stays quiet: Service → Data Store offers nothing', async ({ page }) => {
    await newCanvas(page, 'Continuation silence');
    await create(page, 'Service', { x: 200, y: 300 });
    await create(page, 'Data Store', { x: 520, y: 300 });
    await connect(page, 0, 1);
    await page.locator('.dc-node').nth(0).click();
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
    await expect(page.locator('.dc-ghost')).toHaveCount(0);
  });

  test('a connector dropped on empty canvas leads with the suggestion and previews the highlighted row', async ({ page }) => {
    await newCanvas(page, 'Continuation drop');
    await publisherAndTopic(page);
    await page.keyboard.press('Escape');

    const topic = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await dragHandleTo(page, 1, { x: topic.x + topic.width + 260, y: topic.y + 140 });

    const menu = page.locator('.dc-quick-connect');
    await expect(menu).toBeVisible();
    const rows = menu.locator('.dc-quick-connect-item');
    await expect(rows).toHaveText(['Queue', 'Worker', 'Service', 'Data Store', 'Actor']);
    await expect(rows.nth(0)).toHaveAttribute('data-highlighted', 'true');
    await expect(rows.nth(0)).toHaveAttribute('data-suggested', 'true');
    await expect(page.locator('.dc-ghost')).toHaveAttribute('data-trigger', 'drop');
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'queue');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('fans out');

    // Arrows move the highlight and the ghost follows — sampled immediately, not just eventually,
    // so a one-frame drop to zero candidates between two valid rows would actually be caught.
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.querySelectorAll('.dc-ghost-node').length)).toBeGreaterThan(0);
    await expect(rows.nth(1)).toHaveAttribute('data-highlighted', 'true');
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'service');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('delivers to');

    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.querySelectorAll('.dc-ghost-node').length)).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(captions(page)).toContainText(['publishes', 'fans out']);
  });

  test('the ghost scales with the diagram at a different zoom level and stays functional', async ({ page }) => {
    await newCanvas(page, 'Continuation zoom');
    await publisherAndTopic(page);
    await expect(page.locator('.dc-ghost')).toHaveCount(1);

    const topicBox = (await page.locator('.dc-node').nth(1).boundingBox())!;
    const ghostBoxBefore = (await page.locator('.dc-ghost-node').boundingBox())!;
    const ratioBefore = ghostBoxBefore.width / topicBox.width;

    const zoomOut = page.getByRole('button', { name: 'Zoom out' });
    for (let i = 0; i < 6; i++) await zoomOut.click();
    await expect(page.locator('.dc-ghost')).toHaveCount(1);

    const topicBoxAfter = (await page.locator('.dc-node').nth(1).boundingBox())!;
    const ghostBoxAfter = (await page.locator('.dc-ghost-node').boundingBox())!;
    // A real node and its ghost scale together — the ghost is drawn in the same flow-space
    // viewport, not a separate screen-space overlay that would drift out of proportion.
    expect(topicBoxAfter.width).toBeLessThan(topicBox.width);
    expect(Math.abs(ghostBoxAfter.width / topicBoxAfter.width - ratioBefore)).toBeLessThan(0.05);

    // Still a real, clickable, functioning affordance at the new zoom level.
    await page.locator('.dc-ghost-pill').click();
    await expect(page.locator('.dc-node')).toHaveCount(3);
  });

  test('dismissing the drop picker leaves no preview behind', async ({ page }) => {
    await newCanvas(page, 'Continuation drop dismiss');
    await publisherAndTopic(page);
    await page.keyboard.press('Escape');
    const topic = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await dragHandleTo(page, 1, { x: topic.x + topic.width + 260, y: topic.y + 140 });
    await expect(page.locator('.dc-quick-connect')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-quick-connect')).toBeHidden();
    await expect(page.locator('.dc-ghost')).toHaveCount(0);
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });
});
