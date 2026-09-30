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
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: at });
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
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
}

/** Clicks the middle of a connector's line, on screen, whatever the camera. */
export async function clickEdge(page: Page, line: Locator = page.locator('.dc-edge-line').first()) {
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
