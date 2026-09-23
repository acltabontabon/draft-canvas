import { expect, test, type Page } from '@playwright/test';

/**
 * Clicking and hovering a connector, with a real mouse.
 *
 * Every connector draws a wide invisible hit path, but that was never the whole story: a node's
 * connection handles sit, invisible, over the last stretch of every arrow, and neighbouring
 * connectors' hit paths overlap — so a click on the line itself often selected nothing, a node, or
 * the wrong connector, and only the label was reliable. `canvas/edgePick.ts` now decides; these
 * sample the whole of each route — its ends, its bends, the gaps of a dashed or dotted line, the
 * arrowhead — at several zooms, and check hover and selection stay distinct.
 */

const box = (id: string, x: number, y: number, width = 160, height = 80) => ({ id, type: 'service', x, y, width, height, z: 0, text: id });

function hitDocument() {
  return {
    format: 'draft-canvas',
    version: 1,
    metadata: { id: 'connector-hit', title: 'Connector hits', createdAt: 1, updatedAt: 2 },
    nodes: [
      box('a', 0, 0),
      box('b', 520, 0),
      box('c', 0, 260),
      box('d', 520, 420),
      box('e', 0, 620),
      box('f', 160, 820),
      box('g', 520, 700),
    ],
    edges: [
      // Labelled and dashed (an async call), straight across.
      { id: 'dashed', source: 'a', target: 'b', directed: true, routing: 'smoothstep', label: 'consumed by', async: true },
      // Unlabelled, dotted (an event), with two bends.
      { id: 'dotted', source: 'c', target: 'd', directed: true, routing: 'smoothstep', kind: 'event' },
      // Unlabelled, curved.
      { id: 'curve', source: 'e', target: 'g', directed: true, routing: 'bezier' },
      // Short: most of it is under the handles at either end.
      { id: 'short', source: 'e', target: 'f', directed: true, routing: 'smoothstep' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots' },
  };
}

/** Two parallel connectors between the same pair of shapes, a lane apart. */
function parallelDocument() {
  return {
    format: 'draft-canvas',
    version: 1,
    metadata: { id: 'parallel-hit', title: 'Parallel', createdAt: 1, updatedAt: 2 },
    nodes: [box('a', 0, 0), box('b', 520, 0)],
    edges: [
      { id: 'one', source: 'a', target: 'b', directed: true, routing: 'smoothstep' },
      { id: 'two', source: 'a', target: 'b', directed: true, routing: 'smoothstep' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots' },
  };
}

async function open(page: Page, document: object) {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'hits.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await page.waitForSelector('.dc-editor');
  // Opening frames the diagram with a short ease; sample the settled camera.
  await page.waitForTimeout(700);
}

/** Points along a connector's route on screen, `offset` pixels to one side of it. */
async function routePoints(page: Page, edgeId: string, fractions: number[], offset = 0) {
  return page.locator(`.react-flow__edge[data-id="${edgeId}"] .dc-edge-hit`).first().evaluate(
    (el, { fractions, offset }) => {
      const path = el as SVGPathElement;
      const length = path.getTotalLength();
      const matrix = path.getScreenCTM()!;
      const toScreen = (p: DOMPoint) => p.matrixTransform(matrix);
      return fractions.map((fraction) => {
        const at = toScreen(path.getPointAtLength(length * fraction));
        const before = toScreen(path.getPointAtLength(Math.max(0, length * fraction - 2)));
        const after = toScreen(path.getPointAtLength(Math.min(length, length * fraction + 2)));
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const norm = Math.hypot(dx, dy) || 1;
        return { x: at.x + (-dy / norm) * offset, y: at.y + (dx / norm) * offset };
      });
    },
    { fractions, offset },
  );
}

/** A point `pixels` back along the route from where it meets its target: on the arrowhead. */
/** What the browser has in front at a point: a connector (by id), a node's handle, and its cursor. */
function underPointer(page: Page, at: { x: number; y: number }) {
  return page.evaluate(({ x, y }) => {
    const top = document.elementFromPoint(x, y);
    return {
      edge: top?.closest('.react-flow__edge')?.getAttribute('data-id') ?? null,
      handle: Boolean(top?.closest('.react-flow__handle')),
      cursor: top ? getComputedStyle(top).cursor : '',
    };
  }, at);
}

async function arrowheadPoint(page: Page, edgeId: string, pixels = 5) {
  return page.locator(`.react-flow__edge[data-id="${edgeId}"] .dc-edge-hit`).first().evaluate((el, pixels) => {
    const path = el as SVGPathElement;
    const matrix = path.getScreenCTM()!;
    const zoom = matrix.a;
    const at = path.getPointAtLength(Math.max(0, path.getTotalLength() - pixels / zoom)).matrixTransform(matrix);
    return { x: at.x, y: at.y };
  }, pixels);
}

/** A point on a connector that nothing (a popover, a panel) covers. */
async function visiblePoint(page: Page, edgeId: string) {
  const points = await routePoints(page, edgeId, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  for (const point of points) {
    const clear = await page.evaluate(({ x, y }) => !document.elementFromPoint(x, y)?.closest('[class*="dc-popover"], [class*="inspector"]'), point);
    if (clear) return point;
  }
  throw new Error(`nowhere on ${edgeId} is uncovered`);
}

const selectedEdges = (page: Page) =>
  page.locator('.react-flow__edge:has(.dc-edge[data-selected="true"])').evaluateAll((els) => els.map((el) => el.getAttribute('data-id')));

async function clearSelection(page: Page) {
  await page.keyboard.press('Escape');
  await page.mouse.click(8, 300);
}

async function setZoom(page: Page, zoom: number) {
  // Ctrl+wheel zooms around the pointer, like a trackpad pinch.
  const canvas = page.locator('.react-flow__pane');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const current = async () =>
    page.locator('.react-flow__viewport').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
  for (let i = 0; i < 40 && Math.abs((await current()) - zoom) > 0.08; i += 1) {
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, (await current()) > zoom ? 60 : -60);
    await page.keyboard.up('Control');
    await page.waitForTimeout(40);
  }
  // `--dc-zoom`, which sizes the hit band on screen, follows once the zoom holds still.
  await page.waitForTimeout(300);
}

test.describe('clicking a connector', () => {
  test('anywhere along it selects it — labelled or not, dashed or dotted, straight, bent or curved, arrowhead included', async ({ page }) => {
    await open(page, hitDocument());
    const fractions = [0.04, 0.15, 0.3, 0.45, 0.5, 0.55, 0.7, 0.85, 0.96];
    for (const edge of ['dashed', 'dotted', 'curve', 'short']) {
      for (const offset of [0, 4, -4]) {
        for (const [index, point] of (await routePoints(page, edge, fractions, offset)).entries()) {
          await clearSelection(page);
          await page.mouse.click(point.x, point.y);
          expect(await selectedEdges(page), `${edge} at ${fractions[index]}, ${offset}px off the line`).toEqual([edge]);
        }
      }
      await clearSelection(page);
      const tip = await arrowheadPoint(page, edge);
      await page.mouse.click(tip.x, tip.y);
      expect(await selectedEdges(page), `${edge}'s arrowhead`).toEqual([edge]);
    }
  });

  test('holds on screen at other zooms', async ({ page }) => {
    await open(page, hitDocument());
    for (const zoom of [0.5, 1.6]) {
      await setZoom(page, zoom);
      for (const edge of ['dashed', 'dotted', 'short']) {
        for (const offset of [0, 5, -5]) {
          const pane = (await page.locator('.react-flow__pane').boundingBox())!;
          // Zoomed in, parts of the diagram are off screen or under the toolbar: only what shows counts.
          const onScreen = (point: { x: number; y: number }) =>
            point.x > pane.x + 20 && point.x < pane.x + pane.width - 20 && point.y > pane.y + 70 && point.y < pane.y + pane.height - 50;
          for (const point of (await routePoints(page, edge, [0.1, 0.3, 0.5, 0.7, 0.9], offset)).filter(onScreen)) {
            await clearSelection(page);
            await page.mouse.click(point.x, point.y);
            expect(await selectedEdges(page), `${edge} at zoom ${zoom}, ${offset}px off`).toEqual([edge]);
          }
        }
      }
      // …and no further out than that: a click well clear of every line selects nothing.
      await clearSelection(page);
      const [far] = await routePoints(page, 'dashed', [0.5], 16);
      await page.mouse.click(far!.x, far!.y);
      expect(await selectedEdges(page)).toEqual([]);
    }
  });

  test('a shape still wins inside its own body, and empty canvas still deselects', async ({ page }) => {
    await open(page, hitDocument());
    const [inside] = await routePoints(page, 'dashed', [0], 0);
    // Just inside shape `a`, where the dashed connector leaves it.
    await page.mouse.click(inside!.x - 6, inside!.y);
    expect(await selectedEdges(page)).toEqual([]);
    await expect(page.locator('.react-flow__node[data-id="a"] .dc-node[data-selected="true"]')).toHaveCount(1);

    const [mid] = await routePoints(page, 'dashed', [0.5]);
    await page.mouse.click(mid!.x, mid!.y);
    expect(await selectedEdges(page)).toEqual(['dashed']);
    await page.mouse.click(8, 300);
    expect(await selectedEdges(page)).toEqual([]);
  });

  test('a click changes nothing about the connector — no move, no new connector, nothing to undo', async ({ page }) => {
    await open(page, hitDocument());
    const before = await page.locator('.react-flow__edge[data-id="short"] .dc-edge-hit').first().getAttribute('d');
    for (const point of [await arrowheadPoint(page, 'short'), ...(await routePoints(page, 'short', [0.05, 0.5, 0.95]))]) {
      await page.mouse.click(point.x, point.y);
    }
    await expect(page.locator('.react-flow__edge')).toHaveCount(4);
    await expect(page.locator('.dc-continuation, .dc-quick-connect')).toHaveCount(0);
    expect(await page.locator('.react-flow__edge[data-id="short"] .dc-edge-hit').first().getAttribute('d')).toBe(before);
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();
  });

  test('Shift and ⌘ add a connector to the selection, and take it back off', async ({ page }) => {
    await open(page, hitDocument());
    const [first] = await routePoints(page, 'curve', [0.3]);
    await page.mouse.click(first!.x, first!.y);
    // Selecting one opens its inspector over part of the canvas: aim at a stretch of the other that shows.
    const second = await visiblePoint(page, 'dashed');
    await page.keyboard.down('Shift');
    await page.mouse.click(second.x, second.y);
    await page.keyboard.up('Shift');
    expect((await selectedEdges(page)).sort()).toEqual(['curve', 'dashed']);
    await page.keyboard.down('Meta');
    await page.mouse.click(second.x, second.y);
    await page.keyboard.up('Meta');
    expect(await selectedEdges(page)).toEqual(['curve']);
  });

  test('of two parallel connectors, the one under the pointer wins, not the one painted last', async ({ page }) => {
    await open(page, parallelDocument());
    for (const edge of ['one', 'two']) {
      for (const point of await routePoints(page, edge, [0.25, 0.5, 0.75])) {
        await clearSelection(page);
        await page.mouse.click(point.x, point.y);
        expect(await selectedEdges(page), edge).toEqual([edge]);
      }
    }
  });
});

test.describe('hovering a connector', () => {
  test('marks the one a click would take, differently from selection, and lets go when the pointer leaves', async ({ page }) => {
    await open(page, hitDocument());
    const hovered = page.locator('.react-flow__edge:has(.dc-edge[data-hovered="true"])');
    const tip = await arrowheadPoint(page, 'dotted');
    // On the arrowhead, over the target's handles: still the connector.
    await page.mouse.move(tip.x, tip.y);
    await expect(hovered).toHaveAttribute('data-id', 'dotted');
    await expect(page.locator('.dc-edge-endpoint-hint')).toHaveCount(2);
    await expect(page.locator('.dc-edge-endpoint')).toHaveCount(0);
    // The target's handles aren't showing, so nothing of the shape is in front of its arrowhead.
    expect(await underPointer(page, tip)).toEqual({ edge: 'dotted', handle: false, cursor: 'pointer' });
    // Hovering opens nothing.
    await expect(page.locator('[class*="dc-popover"]')).toHaveCount(0);

    await page.mouse.move(8, 300);
    await expect(hovered).toHaveCount(0);
    await expect(page.locator('.dc-edge-endpoint-hint')).toHaveCount(0);
    await expect(page.locator('[data-edge-hover]')).toHaveCount(0);

    // Selected is its own look: the real endpoint handles, no hover hints.
    const [mid] = await routePoints(page, 'dotted', [0.5]);
    await page.mouse.click(mid!.x, mid!.y);
    await expect(page.locator('.dc-edge-endpoint')).toHaveCount(2);
    await expect(page.locator('.dc-edge[data-selected="true"][data-hovered="true"]')).toHaveCount(0);
    await expect(page.locator('.dc-edge-endpoint-hint')).toHaveCount(0);

    // A selected shape shows its handles, and one sits in front of the arrowhead: it still offers
    // the connector (not a new one), and it alone is told so.
    const target = (await page.locator('.react-flow__node[data-id="d"]').boundingBox())!;
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    await expect(page.locator('.react-flow__node[data-id="d"] .dc-node')).toHaveAttribute('data-selected', 'true');
    await page.mouse.move(tip.x, tip.y);
    await expect(hovered).toHaveAttribute('data-id', 'dotted');
    await expect.poll(() => underPointer(page, tip)).toEqual({ edge: null, handle: true, cursor: 'pointer' });
    await expect(page.locator('[data-edge-hover]')).toHaveCount(1);
    await page.mouse.move(8, 300);
    await expect(page.locator('[data-edge-hover]')).toHaveCount(0);
  });

  test('stands down while panning or dragging a shape, and for an armed tool', async ({ page }) => {
    await open(page, hitDocument());
    const hovered = page.locator('.dc-edge[data-hovered="true"]');
    const [mid] = await routePoints(page, 'dashed', [0.5]);

    // Dragging shape `c` across the dashed line: no hover picked up on the way.
    const node = (await page.locator('.react-flow__node[data-id="c"]').boundingBox())!;
    await page.mouse.move(node.x + 40, node.y + 40);
    await page.mouse.down();
    await page.mouse.move(mid!.x, mid!.y, { steps: 8 });
    await expect(hovered).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');

    await page.getByRole('button', { name: 'Service', exact: true }).click();
    await page.mouse.move(mid!.x, mid!.y + 1);
    await page.mouse.move(mid!.x, mid!.y);
    await expect(hovered).toHaveCount(0);
  });
});
