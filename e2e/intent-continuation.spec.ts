import { expect, test, type Page } from '@playwright/test';
import { connectAndOpen, create, newCanvas, nextFrames } from './canvas';

/**
 * Intent Continuation, driven through the real UI: the ghost that appears beside a node with an
 * obvious next move, Tab/click/Escape on it, one-step undo, and the continuation-aware Quick
 * Connect picker a connector dropped on empty canvas opens. Domain rules themselves are
 * table-tested in `tests/continuation.test.ts`; this covers the interaction.
 */

const CANVAS = '.react-flow__pane';

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
  await page.mouse.move(1, 1); // WebKit refreshes hover only on real movement (see e2e/canvas.ts)
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await nextFrames(page);
  await page.mouse.up();
}

async function connect(page: Page, fromIndex: number, toIndex: number) {
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await dragHandleTo(page, fromIndex, { x: target.x + target.width / 2, y: target.y + target.height / 2 });
}

/**
 * A suggestion waits for the selection to hold still (`CONTINUATION_DWELL_MS`, 250 ms), so a test
 * that expects *no* ghost has to wait that out first or it passes before one could have shown.
 * Tests that expect one just assert it: those polls already outlast the wait.
 */
async function settled(page: Page) {
  await page.waitForTimeout(450);
}

/** Service → Topic, with the Topic left selected and its suggestion showing: the state every ghost test starts from. */
async function publisherAndTopic(page: Page) {
  await create(page, 'Service', { x: 200, y: 300 });
  await create(page, 'Queue', { x: 520, y: 300 });
  await chooseInspectorOption(page, 'Queue type', 'Topic');
  await connect(page, 0, 1);
  // The fresh connector is selected and its popover sits over the Topic; clear it first.
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-edge-inspector')).toHaveCount(0);
  await page.locator('.dc-node').nth(1).click();
  await expect(page.locator('.dc-ghost')).toHaveCount(1);
}

// Captions are drawn in the label layer above every line, not inside the connector's SVG.
const captions = (page: Page) => page.locator('.dc-edge-caption');

test.describe('Intent Continuation', () => {
  test('a Topic with a publisher offers a Queue; Tab adds it, then a Worker; undo takes one step back', async ({ page }) => {
    await newCanvas(page, 'Continuation chain');
    await publisherAndTopic(page);

    const ghost = page.locator('.dc-ghost');
    await expect(ghost).toHaveAttribute('data-trigger', 'select');
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'queue');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('fans out to');
    await expect(page.locator('.dc-ghost-pill')).toContainText('Queue');
    // Alternatives exist, so the pill counts them — quietly, one ghost at a time.
    await expect(page.locator('.dc-ghost-pill-next')).toContainText('1/3');

    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(captions(page)).toContainText(['publishes to', 'fans out to']);
    // The new Queue is selected and, having no consumer, offers a Worker next.
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'service');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('consumed by');

    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(4);
    await expect(captions(page)).toContainText(['publishes to', 'fans out to', 'consumed by']);
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
    await nextFrames(page);
    await page.mouse.up();

    // Still the same one node selected (the resize did not steal or drop selection) and the same
    // suggestion is showing, not a stale or broken one.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'queue');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('fans out to');

    // And it is functionally intact, not just visually present.
    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(captions(page)).toContainText(['publishes to', 'fans out to']);
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
    await page.locator('.dc-ghost-pill-accept').click();
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(captions(page)).toContainText(['publishes to', 'fans out to']);
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
    await settled(page);
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
    await settled(page);
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
    await expect(rows).toHaveText(['Queue', 'Queue → Worker', 'Worker', 'Service', 'Data Store', 'Actor']);
    await expect(rows.nth(0)).toHaveAttribute('data-highlighted', 'true');
    await expect(rows.nth(0)).toHaveAttribute('data-suggested', 'true');
    await expect(page.locator('.dc-ghost')).toHaveAttribute('data-trigger', 'drop');
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'queue');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('fans out to');

    // Arrows move the highlight and the ghost follows — sampled immediately, not just eventually,
    // so a one-frame drop to zero candidates between two valid rows would actually be caught.
    await page.keyboard.press('ArrowDown');
    expect(await page.evaluate(() => document.querySelectorAll('.dc-ghost-node').length)).toBeGreaterThan(0);
    await expect(rows.nth(1)).toHaveAttribute('data-highlighted', 'true');
    // A compound row previews the whole fragment it would add.
    await expect(page.locator('.dc-ghost-node')).toHaveCount(2);
    await expect(page.locator('.dc-ghost-edges text')).toHaveText(['fans out to', 'consumed by']);

    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(2)).toHaveAttribute('data-highlighted', 'true');
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'service');
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('delivers to');

    await page.keyboard.press('ArrowUp');

    await page.keyboard.press('ArrowUp');
    expect(await page.evaluate(() => document.querySelectorAll('.dc-ghost-node').length)).toBeGreaterThan(0);
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(captions(page)).toContainText(['publishes to', 'fans out to']);
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
    await page.locator('.dc-ghost-pill-accept').click();
    await expect(page.locator('.dc-node')).toHaveCount(3);
  });

  test('] and [ cycle the alternatives through one ghost, and Tab adds whichever is showing', async ({ page }) => {
    await newCanvas(page, 'Continuation cycling');
    await publisherAndTopic(page);
    const next = page.locator('.dc-ghost-pill-next');
    await expect(next).toContainText('1/3');

    await page.keyboard.press(']');
    await expect(next).toContainText('2/3');
    await expect(page.locator('.dc-ghost')).toHaveCount(1);
    await expect(page.locator('.dc-ghost-node')).toHaveCount(2);
    await expect(page.locator('.dc-ghost-pill')).toContainText('Queue → Worker');

    await page.keyboard.press(']');
    await expect(next).toContainText('3/3');
    await expect(page.locator('.dc-ghost-node')).toHaveCount(1);
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'service');
    await page.keyboard.press(']');
    await expect(next).toContainText('1/3');
    await page.keyboard.press('[');
    await expect(next).toContainText('3/3');
    await page.keyboard.press('[');
    await expect(next).toContainText('2/3');

    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(4);
    await expect(captions(page)).toContainText(['publishes to', 'fans out to', 'consumed by']);
    // One step undoes the whole fragment.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });

  test('clicking the count steps to the next alternative', async ({ page }) => {
    await newCanvas(page, 'Continuation cycling click');
    await publisherAndTopic(page);
    await page.locator('.dc-ghost-pill-next').click();
    await expect(page.locator('.dc-ghost-pill-next')).toContainText('2/3');
    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(4);
  });

  test('a shape already on the canvas is connected to rather than drawn again', async ({ page }) => {
    await newCanvas(page, 'Continuation existing');
    // Actor → Service, so the Service is mid-sentence, then a Topic drawn next to it but not wired.
    await create(page, 'Actor', { x: 120, y: 300 });
    await create(page, 'Service', { x: 380, y: 300 });
    await connect(page, 0, 1);
    await page.keyboard.press('Escape');
    await create(page, 'Queue', { x: 660, y: 300 });
    await chooseInspectorOption(page, 'Queue type', 'Topic');
    await page.locator('.dc-node').nth(1).click();

    await expect(page.locator('.dc-ghost')).toHaveCount(1);
    await expect(page.locator('.dc-ghost-node')).toHaveCount(0);
    await expect(page.locator('.dc-ghost-target')).toHaveCount(1);
    await expect(page.locator('.dc-ghost-edges text')).toHaveText('publishes to');
    await expect(page.locator('.dc-ghost-pill')).toContainText('Connect');

    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(page.locator('.dc-edge')).toHaveCount(2);
    await expect(captions(page)).toContainText(['calls', 'publishes to']);
    // The topic is now selected and continues the sentence.
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'queue');
  });

  test('a saga drawn by hand: a step gets its undo from the inspector, and ] offers the steps still missing one', async ({
    page,
  }) => {
    await newCanvas(page, 'Continuation hand-drawn saga');
    await create(page, 'Service', { x: 160, y: 330 });
    await create(page, 'Service', { x: 600, y: 90 });
    await create(page, 'Service', { x: 600, y: 250 });
    await create(page, 'Service', { x: 600, y: 410 });
    await create(page, 'Service', { x: 600, y: 570 });

    // Compensates remains available on the relationship menu for a standalone legacy connector.
    await connectAndOpen(page, 0, 1);
    await inspectorSelect(page, 'Protocol').click();
    await expect(page.getByRole('option')).toHaveText(['HTTP', 'Generic Call', 'Compensates']);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '+ Add compensating action' }).click();
    await expect(page.locator('.dc-edge')).toHaveCount(1);
    await expect(page.locator('.dc-edge-compensation-marker')).toHaveCount(0);
    await page.locator('.dc-node').nth(2).click();
    await expect(page.locator('.dc-edge')).toHaveCount(2);
    await page.keyboard.press('Escape');

    // Two more calls remain eligible for the continuation's recovery suggestion.
    await connect(page, 0, 3);
    await expect(page.locator('.dc-edge')).toHaveCount(3);
    await expect(page.locator('.dc-edge-compensation-marker')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await connect(page, 0, 4);
    await page.keyboard.press('Escape');

    await page.locator('.dc-node').nth(0).click();
    await page.keyboard.press(']');
    await expect(page.locator('.dc-ghost-pill')).toContainText('Compensate');
    await expect(page.locator('.dc-ghost-target')).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(page.locator('.dc-edge')).toHaveCount(5);
    await expect(page.locator('.dc-edge-compensation-marker')).toHaveCount(0);
  });

  test('] asks for suggestions where none show on their own, and typing a label never cycles', async ({ page }) => {
    await newCanvas(page, 'Continuation ask');
    await create(page, 'Service', { x: 300, y: 300 });
    await page.locator('.dc-node').nth(0).click();
    await settled(page);
    await expect(page.locator('.dc-ghost')).toHaveCount(0);

    await page.keyboard.press(']');
    await expect(page.locator('.dc-ghost')).toHaveCount(1);
    await expect(page.locator('.dc-ghost-pill')).toContainText('Data Store');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-ghost')).toHaveCount(0);

    await page.keyboard.press('Enter');
    await page.keyboard.type('Orders]');
    await expect(page.locator('.dc-ghost')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node').nth(0)).toContainText('Orders]');
  });

  test('] on a shape with no suggestion asks back: the picker opens on it, saying why', async ({ page }) => {
    await newCanvas(page, 'Continuation won’t guess');
    await create(page, 'Data Store', { x: 300, y: 300 });
    await chooseInspectorOption(page, 'Data Store type', 'Table');
    await page.keyboard.press('Escape');
    await page.locator('.dc-node').nth(0).click();
    await settled(page);
    await expect(page.locator('.dc-ghost')).toHaveCount(0);

    await page.keyboard.press(']');
    const picker = page.getByRole('menu', { name: 'Add to canvas' });
    await expect(picker).toBeVisible();
    await expect(page.locator('.dc-quick-connect-note')).toContainText('outbox');
    await expect(picker).toHaveAccessibleDescription(/outbox, a read model or plain business data/);
    // The note is not a choice: the first row is highlighted and previewed beside the Table.
    await expect(page.locator('.dc-quick-connect-item').first()).toHaveAttribute('data-highlighted', 'true');
    await expect(page.locator('.dc-ghost')).toHaveCount(1);

    await page.keyboard.press('Enter');
    await expect(picker).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(2);
    await expect(page.locator('.dc-edge')).toHaveCount(1);
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

  test("the pill's position is never animated: it sits beside its ghost from its first frame, not at the layer's origin", async ({
    page,
  }) => {
    // The pill is placed by an inline `transform`, and a running CSS animation replaces the whole
    // `transform` property — so a fade written with `transform` in its keyframes parked the pill at the
    // layer's origin for the 120 ms it ran, then jumped it into place. The same hazard the ghost's own
    // body is kept clear of (above), checked two ways: structurally, and by sampling every frame.
    await newCanvas(page, 'Continuation pill position');
    await publisherAndTopic(page);
    const pill = page.locator('.dc-ghost-pill');
    const { name, touchesTransform } = await pill.evaluate((el) => {
      const name = getComputedStyle(el).animationName;
      const rule = [...document.styleSheets]
        .flatMap((sheet) => [...sheet.cssRules])
        .flatMap((rule) => (rule instanceof CSSKeyframesRule && rule.name === name ? [...rule.cssRules] : []));
      return { name, touchesTransform: rule.some((frame) => (frame as CSSKeyframeRule).style.getPropertyValue('transform') !== '') };
    });
    expect(name === 'none' || !touchesTransform, `animation ${name} must not touch transform`).toBe(true);

    // Reselect, sampling the pill's box on every frame from before it mounts until well after it has faded in.
    await page.locator(CANVAS).click({ position: { x: 700, y: 600 } });
    await expect(page.locator('.dc-ghost')).toHaveCount(0);
    await page.evaluate(() => {
      const seen: { x: number; y: number }[] = [];
      (window as unknown as { __pillBoxes: typeof seen }).__pillBoxes = seen;
      const until = performance.now() + 1500;
      const sample = () => {
        const el = document.querySelector('.dc-ghost-pill');
        if (el) {
          const box = el.getBoundingClientRect();
          seen.push({ x: Math.round(box.x), y: Math.round(box.y) });
        }
        if (performance.now() < until) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.locator('.dc-node').nth(1).click();
    await expect(pill).toHaveCount(1);
    await page.waitForTimeout(1600);
    const boxes = await page.evaluate(() => (window as unknown as { __pillBoxes: { x: number; y: number }[] }).__pillBoxes);
    expect(boxes.length).toBeGreaterThan(4);
    const last = boxes.at(-1)!;
    for (const box of boxes) {
      expect(Math.abs(box.x - last.x), `x ${box.x} vs settled ${last.x}`).toBeLessThanOrEqual(2);
      expect(Math.abs(box.y - last.y), `y ${box.y} vs settled ${last.y}`).toBeLessThanOrEqual(2);
    }
  });

  test('the pill says why it is offered and how to wave it away, and its count names both numbers', async ({ page }) => {
    await newCanvas(page, 'Continuation pill words');
    await publisherAndTopic(page);
    const pill = page.locator('.dc-ghost-pill');
    await expect(pill).toHaveAttribute('title', /This topic has a publisher but no delivery path\.\nEsc to dismiss/);
    await expect(page.getByRole('button', { name: 'Next suggestion, 1 of 3 (])' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Add Queue after .* \(Tab\)$/ })).toBeVisible();
    // A hover-free, keyboard-free person has a dismiss button on touch; with a mouse there is none.
    await expect(page.locator('.dc-ghost-pill-dismiss')).toBeHidden();
  });

  test('] with nothing else to step to says so, without a toast', async ({ page }) => {
    await newCanvas(page, 'Continuation no other');
    await create(page, 'Service', { x: 200, y: 300 });
    await create(page, 'Queue', { x: 520, y: 300 });
    await connect(page, 0, 1);
    await page.keyboard.press('Escape');
    await page.locator('.dc-node').nth(1).click();
    await expect(page.locator('.dc-ghost-pill')).toContainText('Worker');
    // One suggestion, so no count to step through.
    await expect(page.locator('.dc-ghost-pill-next')).toHaveCount(0);

    await page.keyboard.press(']');
    await expect(page.locator('.dc-ghost-pill-note')).toHaveText('No other suggestions');
    await expect(page.getByText('No other suggestions')).toHaveCount(2); // the pill, and the live region
    await expect(page.locator('.dc-toast')).toHaveCount(0);
    await expect(page.locator('.dc-ghost-pill-note')).toHaveCount(0); // and it clears itself
    await expect(page.locator('.dc-ghost')).toHaveCount(1);
  });

  test('a suggestion appears only once the selection has settled: arrowing past a shape shows none', async ({ page }) => {
    await newCanvas(page, 'Continuation dwell');
    await publisherAndTopic(page);
    // Select the publisher and the topic again in quick succession: no ghost for the one passed over,
    // and the topic's own arrives after it.
    await page.locator('.dc-node').nth(0).click();
    await page.locator('.dc-node').nth(1).click();
    await expect(page.locator('.dc-ghost')).toHaveCount(1);
    await expect(page.locator('.dc-ghost-node')).toHaveAttribute('data-type', 'queue');
  });

  test("Escape with the node's colour panel open closes only the panel, and the ghost stays", async ({ page }) => {
    await newCanvas(page, 'Continuation panel escape');
    await publisherAndTopic(page);
    await expect(page.locator('.dc-ghost')).toHaveCount(1);

    await page.getByRole('button', { name: 'Element colour' }).click();
    await expect(page.locator('.dc-popover-panel')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-popover-panel')).toHaveCount(0);
    await expect(page.locator('.dc-ghost')).toHaveCount(1);

    // The next Escape is the ghost's, as before.
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-ghost')).toHaveCount(0);
  });
});
