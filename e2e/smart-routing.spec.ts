import { expect, test, type Page } from '@playwright/test';

/**
 * Smart Routing on the live canvas.
 *
 * The geometry itself is unit-tested in `tests/edge-bundles.test.ts`; what can
 * only be checked here is that a diagram drawn the way a person actually draws
 * one — drag a connector, drop it on a node, five times — comes out bundled,
 * and that bundling stayed a *visual* change: five connectors drawn through one
 * trunk are still five independently selectable relationships.
 */

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

async function create(page: Page, tool: string, at: { x: number; y: number }) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: at });
}

/** `.dc-node` indices ordered left-to-right, then top-to-bottom. React Flow
 *  reorders nodes in the DOM as selection changes, so this is re-read
 *  immediately before every use rather than cached. */
async function ordered(page: Page): Promise<number[]> {
  const boxes = await page.locator('.dc-node').evaluateAll((els) =>
    els.map((el, i) => {
      const rect = el.getBoundingClientRect();
      return { i, x: rect.x, y: rect.y };
    }),
  );
  return boxes.sort((a, b) => a.x - b.x || a.y - b.y).map((box) => box.i);
}

async function connect(page: Page, fromIndex: number, toIndex: number) {
  const source = page.locator('.dc-node').nth(fromIndex);
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

/** One hub on the left calling five services stacked down the right — the shape
 *  the whole feature exists for. */
async function fanOut(page: Page) {
  await page.setViewportSize({ width: 1400, height: 950 });
  await newCanvas(page, 'Smart routing fan-out');
  await create(page, 'Service', { x: 120, y: 430 });
  for (const y of [90, 250, 410, 570, 730]) await create(page, 'Service', { x: 820, y });
  for (let n = 0; n < 5; n += 1) {
    const order = await ordered(page);
    await connect(page, order[0]!, order.slice(1)[n]!);
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(300);
}

test.describe('Smart Routing — fan-out on the live canvas', () => {
  test('routes five sibling calls through one shared trunk, still as five relationships', async ({ page }) => {
    await fanOut(page);

    // The semantic graph is untouched: five connectors in, five out. Nothing
    // was collapsed into a junction to make the picture tidy.
    await expect(page.locator('.dc-edge')).toHaveCount(5);
    await expect(page.locator('.dc-statusbar, .dc-status').first()).toContainText('5 connections');

    // Every member turns onto the same vertical trunk, so each path contains
    // the same x twice — once entering it, once leaving.
    const trunkXs = await page.locator('.dc-edge-hit').evaluateAll((paths) =>
      paths.map((path) => {
        const turns = (path.getAttribute('d') ?? '').match(/[ML](-?\d+(?:\.\d+)?) /g) ?? [];
        return turns.map((t) => t.slice(1).trim());
      }),
    );
    const shared = trunkXs[0]!.filter((x) => trunkXs.every((xs) => xs.includes(x)));
    expect(shared.length).toBeGreaterThan(0);
  });

  test('collapses the repeated relationship caption onto the trunk', async ({ page }) => {
    await fanOut(page);

    const captions = page.locator('svg text').filter({ hasText: 'calls' });
    await expect(captions).toHaveCount(5);
    // All five are drawn, but at one point — so the reader sees a single
    // "calls" on the shared stem rather than five copies down a column.
    const positions = await captions.evaluateAll((els) =>
      els.map((el) => `${el.getAttribute('x')},${el.getAttribute('y')}`),
    );
    expect(new Set(positions).size).toBe(1);
  });

  test('selection still resolves to one real connector, not the trunk', async ({ page }) => {
    await fanOut(page);

    // A path's bounding-box centre is not on the path itself when the path is
    // an L, so ask the SVG where the line actually runs and click there —
    // three-quarters along, which is out on this member's own branch.
    const point = await page.locator('.dc-edge-hit').first().evaluate((el) => {
      const path = el as SVGPathElement;
      const at = path.getPointAtLength(path.getTotalLength() * 0.75);
      const screen = at.matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
    await page.mouse.click(point.x, point.y);

    // A shared trunk is never itself selectable — clicking always lands on one
    // of the semantic edges travelling along it.
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
  });
});
