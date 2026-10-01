import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The steps most canvas specs share, in one place — each used to carry its own copy, so a change
 * to how a shape arrives (it now opens ready to name) meant the same edit in thirteen files.
 */

/** A fresh canvas from the Library, titled so a later reload can find it. */
export async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

/**
 * Arms a toolbar tool and places one shape. A new shape opens ready to name; Escape keeps the
 * default name and leaves it selected, so the rest of a test sees the same plain, selected node it
 * always did — and the next keystroke is a shortcut again, not a letter in the name. A Note opens
 * the same way (Escape commits it empty). A new Text node is deleted the instant it is left untyped
 * (`finishTextEdit`, so it never becomes an invisible ghost), so it is given a word and committed.
 */
export async function create(page: Page, tool: string, at: { x: number; y: number }) {
  const pane = page.locator('.react-flow__pane');
  const box = (await pane.boundingBox())!;
  const point = { x: box.x + at.x, y: box.y + at.y };
  // Only where something actually sits on the point this clicks: the selected shape's options
  // toolbar can, where an engine's fonts make it wider. Escape clears that selection (a toolbar
  // means something is selected, so this never steps out of a level). Anywhere else the selection
  // is left exactly as the test made it.
  //
  // Judged only once the toolbar has landed: it mounts a frame after a single shape is selected and
  // grows in over 120 ms, so a check made straight after naming the last shape saw open canvas and
  // Firefox's click then went into the toolbar.
  await page.mouse.move(point.x, point.y);
  const toolbars = page.locator('.dc-element-inspector:not([data-closing="true"]), .dc-edge-inspector:not([data-closing="true"])');
  const oneShapeSelected =
    (await page.locator('.react-flow__node.selected').count()) === 1 && (await page.locator('.react-flow__edge.selected').count()) === 0;
  if (oneShapeSelected) await toolbars.first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
  const covered = await toolbars.evaluateAll(
    async (elements, [x, y]) => {
      const entrances = elements.flatMap((el) => el.getAnimations({ subtree: true }));
      await Promise.all(
        entrances.filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => undefined)),
      );
      return elements.some((el) => {
        const r = el.getBoundingClientRect();
        return x >= r.left - 8 && x <= r.right + 8 && y >= r.top - 8 && y <= r.bottom + 8;
      });
    },
    [point.x, point.y] as const,
  );
  if (covered) {
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-element-inspector, .dc-edge-inspector')).toHaveCount(0);
  }
  await page.getByRole('button', { name: tool, exact: true }).click();
  // Off the button again before clicking, as a hand would be: its tooltip can sit on the point.
  await page.mouse.move(point.x, point.y);
  await pane.click({ position: at });
  if (tool === 'Text') {
    await page.keyboard.type('Text');
    await page.keyboard.press('ControlOrMeta+Enter');
    return;
  }
  const editor = page.locator('.dc-node-editor');
  if ((await editor.count()) > 0) {
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);
  }
}

/** Drags from a node's right-hand handle onto another node. */
export async function connect(page: Page, fromIndex: number, toIndex: number) {
  const source = page.locator('.dc-node').nth(fromIndex);
  // Off and back on: a drag that just ended over this shape leaves the pointer exactly where
  // `hover()` would put it, and WebKit only refreshes hover on real movement — so the handles stay
  // hidden and the next drag starts on bare canvas.
  await page.mouse.move(1, 1);
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await nextFrames(page);
  await page.mouse.up();
}

/** Clicks the middle of a connector's line, on screen, whatever the camera. */
export async function clickEdge(page: Page, line: Locator = page.locator('.dc-edge-line').first()) {
  // The point is read off the screen: a camera still easing (a fit after a starter, a framing step)
  // would put the click where the connector was a frame ago.
  await cameraAtRest(page);
  const point = await line.evaluate((el: SVGPathElement) => {
    const len = el.getTotalLength();
    const p = el.getPointAtLength(len / 2);
    const screenPoint = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM()!);
    return { x: screenPoint.x, y: screenPoint.y };
  });
  await page.mouse.click(point.x, point.y);
}

/**
 * Draws a connector and opens its panel. A connector just drawn stays selected with its panel
 * closed until it is asked for (clicked, or Enter) — so the shapes behind it stay readable, and
 * a run of connections isn't a run of panels.
 */
export async function connectAndOpen(page: Page, fromIndex: number, toIndex: number) {
  await connect(page, fromIndex, toIndex);
  const drawn = page.locator('.dc-edge[data-selected="true"]');
  await expect(drawn).toHaveCount(1);
  await clickEdge(page, drawn.locator('.dc-edge-line'));
  await expect(page.locator('.dc-edge-inspector')).toBeVisible();
}

/**
 * Reloads the page and waits for the same canvas to come back. The open canvas lives in the
 * address (`#doc=`), so a refresh lands on it directly, not on the Library.
 */
export async function reopenAfterReload(page: Page, title: string) {
  await page.reload();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.getByLabel('Diagram title')).toHaveValue(title);
}

/**
 * The camera has stopped, and the hit band has caught up with it. A move is a per-frame d3
 * transition, so a transform that holds still over several consecutive frames has finished
 * (or never began — the still frames outlast the one-frame lag before a move's first tick);
 * `--dc-zoom`, which sizes the hit band on screen, follows the zoom only once it has held still
 * (`Canvas.tsx`'s `useZoomVariable`), so it matching the live zoom is what makes a click land where
 * the band is drawn rather than where it was.
 */
export async function cameraAtRest(page: Page) {
  // `page.evaluate` awaits the frames; `waitForFunction` would take the pending promise as truthy.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
          const root = document.querySelector<HTMLElement>('.react-flow');
          if (!viewport || !root) return false;
          const transform = viewport.style.transform;
          for (let frame = 0; frame < 6; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (viewport.style.transform !== transform) return false;
          }
          const zoom = Number(/scale\(([-\d.]+)\)/.exec(transform)?.[1] ?? 1);
          return root.style.getPropertyValue('--dc-zoom') === String(Math.round(zoom * 20) / 20);
        }),
      { message: 'the camera has come to rest and --dc-zoom has followed it' },
    )
    .toBe(true);
}

/**
 * Two rendered frames. Before releasing a synthetic drag: WebKit coalesces pointer moves into the
 * next frame, so a mouse-up sent in the same frame as the last of a burst of moves can land before
 * the shape has caught up — and the drop happens a step or two short of where the pointer is.
 */
export async function nextFrames(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/**
 * After dropping a shape, before the next click. React Flow drags shapes with d3-drag, which eats
 * the click that ends a drag through a window listener it removes on a zero-delay timer — and
 * Chromium runs input ahead of timers, so a click sent straight after a busy drop (a card folding
 * into a connector) landed while that guard was still up and selected nothing. A timer queued now
 * fires after d3's.
 */
export async function afterDropGuard(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}
