import { expect, test, type Page } from '@playwright/test';

/**
 * Line jumps on the live canvas.
 *
 * The geometry itself is unit-tested in `tests/edge-crossings.test.ts` and
 * `tests/edge-crossing-plan.test.ts`. What can only be checked here is that the thing a person
 * actually draws — two connectors that happen to cross — comes out with a hump on one of them, that
 * the hump follows the diagram when a shape moves, and that it stayed a purely *visual* change: the
 * connector underneath is selected, labelled and deleted exactly as it was.
 *
 * It also carries the one parity check the unit tests cannot: connectors are drawn by two
 * independent renderers (see `docs/reference/architecture.md`'s "two seams"), and only a browser has both the
 * live canvas and the exporter in the same process to compare.
 */

/**
 * A diagram whose two connectors genuinely cross: a long horizontal run between two shapes, and an
 * independent vertical one between two more, meeting in open canvas. Imported as a file rather than
 * drawn, because what is under test is what happens *after* two connectors cross, not the drawing.
 */
function crossingDocument() {
  const box = (id: string, x: number, y: number) => ({
    id,
    type: 'service',
    x,
    y,
    width: 160,
    height: 80,
    z: 0,
    text: id,
  });
  return {
    format: 'draft-canvas',
    version: 1,
    metadata: { id: 'crossing', title: 'Line jumps', createdAt: 1, updatedAt: 2 },
    nodes: [box('a', 0, 300), box('b', 800, 300), box('up', 380, 0), box('down', 380, 620)],
    edges: [
      { id: 'across', source: 'a', target: 'b', directed: true, routing: 'smoothstep' },
      { id: 'down', source: 'up', target: 'down', directed: true, routing: 'smoothstep' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots' },
  };
}

async function crossingDiagram(page: Page) {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'crossing.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(crossingDocument())),
  });
  await page.waitForSelector('.dc-editor');
  await expect(page.locator('.dc-edge-line')).toHaveCount(2);
}

/** Clicks a connector where its line actually runs. The hit area is the canonical route — a hump
 *  never widens or moves it — so this lands exactly as it did before humps existed. */
async function clickLine(page: Page, edgeId: string) {
  const point = await page
    .locator(`.react-flow__edge[data-id="${edgeId}"] .dc-edge-hit`)
    .evaluate((el) => {
      const path = el as SVGPathElement;
      const at = path.getPointAtLength(path.getTotalLength() * 0.25);
      const screen = at.matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
  await page.mouse.click(point.x, point.y);
}

/** How many humps a connector's drawn line carries. Each is two cubics — one easing up to the
 *  apex, one easing back down — so that its shoulders meet the line travelling along it. */
async function humps(page: Page, edgeId: string): Promise<number> {
  const d = await page.locator(`.react-flow__edge[data-id="${edgeId}"] .dc-edge-line`).getAttribute('d');
  return ((d ?? '').match(/C/g) ?? []).length / 2;
}

/**
 * One long horizontal connector crossed by two independent vertical ones. The horizontal line owns
 * both hops, which is what makes it the interesting one to disturb: moving a shape on *one* of the
 * vertical connectors makes only *some* of its crossings unreliable.
 */
function doubleCrossingDocument() {
  const box = (id: string, x: number, y: number) => ({
    id,
    type: 'service',
    x,
    y,
    width: 160,
    height: 80,
    z: 0,
    text: id,
  });
  return {
    format: 'draft-canvas',
    version: 1,
    metadata: { id: 'double-crossing', title: 'Two crossings', createdAt: 1, updatedAt: 2 },
    nodes: [
      box('a', 0, 300),
      box('b', 1000, 300),
      box('up1', 300, 0),
      box('down1', 300, 620),
      box('up2', 640, 0),
      box('down2', 640, 620),
    ],
    edges: [
      { id: 'across', source: 'a', target: 'b', directed: true, routing: 'smoothstep' },
      { id: 'left', source: 'up1', target: 'down1', directed: true, routing: 'smoothstep' },
      { id: 'right', source: 'up2', target: 'down2', directed: true, routing: 'smoothstep' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots' },
  };
}

test.describe('line jumps', () => {
  test('dragging a shape that only some of a connector\'s crossings involve keeps the canvas alive', async ({
    page,
  }) => {
    const problems: string[] = [];
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console: ${message.text()}`);
    });

    await page.goto('/');
    await page.setInputFiles('input[type="file"]', {
      name: 'double-crossing.draftcanvas',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(doubleCrossingDocument())),
    });
    await page.waitForSelector('.dc-editor');
    await expect(page.locator('.dc-edge-line')).toHaveCount(3);
    // Both crossings are the horizontal connector's to hop.
    await expect.poll(() => humps(page, 'across')).toBe(2);

    // Pick up a shape on the left vertical connector and carry it a little way, staying mid-drag.
    const grabbed = (await page.locator('.react-flow__node[data-id="up1"] .dc-node').boundingBox())!;
    const start = { x: grabbed.x + grabbed.width / 2, y: grabbed.y + grabbed.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) {
      await page.mouse.move(start.x + step * 6, start.y + step * 2);
    }

    // Mid-drag, the canvas is still there: every connector still drawn, nothing thrown.
    await expect(page.locator('.dc-edge-line')).toHaveCount(3);
    await expect(page.locator('.dc-node')).toHaveCount(6);

    await page.mouse.up();
    await expect(page.locator('.dc-edge-line')).toHaveCount(3);
    await expect(page.locator('.dc-node')).toHaveCount(6);
    // The crossing the moved shape is not part of survives the whole gesture.
    await expect.poll(() => humps(page, 'across')).toBeGreaterThanOrEqual(1);

    expect(problems).toEqual([]);
  });

  test('the horizontal connector hops over the vertical one', async ({ page }) => {
    await crossingDiagram(page);

    expect(await humps(page, 'across')).toBe(1);
    expect(await humps(page, 'down')).toBe(0);
  });

  test('the hump goes when the crossing does, and comes back with it', async ({ page }) => {
    await crossingDiagram(page);
    expect(await humps(page, 'across')).toBe(1);

    // Take away the connector being hopped over. Nothing crosses any more, so nothing hops.
    await clickLine(page, 'down');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.dc-edge-line')).toHaveCount(1);
    await expect.poll(() => humps(page, 'across')).toBe(0);

    // Undo brings it back, and the hump comes with it — nothing about the hump was ever recorded,
    // so there is nothing for undo to restore but the connector itself.
    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-edge-line')).toHaveCount(2);
    await expect.poll(() => humps(page, 'across')).toBe(1);
  });

  test('the connector underneath is still an ordinary connector', async ({ page }) => {
    await crossingDiagram(page);

    await clickLine(page, 'across');
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);

    // And it deletes like any other, taking its hump with it and leaving the other connector alone.
    await page.keyboard.press('Backspace');
    await expect(page.locator('.dc-edge-line')).toHaveCount(1);
    expect(await humps(page, 'down')).toBe(0);

    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-edge-line')).toHaveCount(2);
    await expect.poll(() => humps(page, 'across')).toBe(1);
  });

  test('the hit area never carries the hump', async ({ page }) => {
    await crossingDiagram(page);

    // Presentation callouts read this path's `d` straight off the DOM, and every overlay is placed
    // from the same canonical route. A hump belongs only to the drawn line.
    const hit = await page.locator('.react-flow__edge[data-id="across"] .dc-edge-hit').getAttribute('d');
    expect(hit).not.toContain('C');
  });

  test('an exported image draws the same hump the canvas does', async ({ page }) => {
    await crossingDiagram(page);

    await expect.poll(() => humps(page, 'across')).toBe(1);

    const live = (
      await page.locator('.dc-edge-line').evaluateAll((paths) => paths.map((p) => p.getAttribute('d') ?? ''))
    ).filter((d) => d.includes('C'));

    // The exporter is handed the same file the canvas was opened from, rather than the live store:
    // a module imported in here is a second instance of itself, with a store of its own that
    // nothing ever populated. The renderers are pure, so the document is all they need to agree.
    const exported = await page.evaluate(async (text) => {
      const project = await import('/src/export/project.ts');
      const svgmod = await import('/src/render/svg/document.ts');
      const parsed = project.deserializeDocument(text);
      const svg = svgmod.renderDocumentSvg(parsed.document, { theme: 'dark' }).svg;
      return [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]!).filter((d) => d.includes('C'));
    }, JSON.stringify(crossingDocument()));

    // The two renderers are independent implementations; this is the assertion that keeps them
    // from quietly disagreeing about line jumps.
    expect(exported).toEqual(live);
    expect(live).toHaveLength(1);
  });
});
