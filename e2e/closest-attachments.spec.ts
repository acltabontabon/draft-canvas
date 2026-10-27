import { expect, test, type Page } from '@playwright/test';
import { nearbyServicesDocument } from '../tests/fixtures/connectors/nearby';
import { serializeDocument } from '../src/export/project';
import { cameraAtRest } from './canvas';

async function open(page: Page, pinned = false) {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', { name: 'nearby.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(serializeDocument(nearbyServicesDocument(pinned))) });
  await expect(page.locator('.dc-editor')).toBeVisible();
  await cameraAtRest(page);
}

const pathFor = (page: Page) => page.locator('.react-flow__edge[data-id="nearby"] .dc-edge-hit').first();

async function ends(page: Page) {
  return pathFor(page).evaluate(element => {
    const path = element as SVGPathElement;
    const length = path.getTotalLength();
    const screen = (at: number) => {
      const p = path.getPointAtLength(at).matrixTransform(path.getScreenCTM()!);
      return { x: p.x, y: p.y };
    };
    return { from: screen(0), to: screen(length), length };
  });
}

test('fixed attachment points are visible and one click switches the old loop to the nearest sides', async ({ page }) => {
  await open(page, true);
  const before = await pathFor(page).getAttribute('d');
  const click = await pathFor(page).evaluate(element => {
    const path = element as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() * 0.25).matrixTransform(path.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(click.x, click.y);
  await expect(page.getByRole('button', { name: 'Pinned', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Auto', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Auto', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const routed = await ends(page);
  const source = (await page.locator('.react-flow__node[data-id="source"]').boundingBox())!;
  const target = (await page.locator('.react-flow__node[data-id="near"]').boundingBox())!;
  expect(routed.from.x).toBeCloseTo(source.x + source.width, 1);
  expect(routed.to.x).toBeCloseTo(target.x, 1);
  expect(routed.from.y).toBeCloseTo(routed.to.y, 1);
  expect(routed.length).toBeCloseTo(60, 1);
  const automatic = await pathFor(page).getAttribute('d');
  await page.getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pinned', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await pathFor(page).getAttribute('d')).toBe(automatic);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await pathFor(page).getAttribute('d')).toBe(before);
});

test('an automatic connector uses the shared side band and follows a moved shape onto new sides', async ({ page }) => {
  await open(page);
  expect((await ends(page)).length).toBeCloseTo(60, 1);
  const target = (await page.locator('.react-flow__node[data-id="near"]').boundingBox())!;
  const source = (await page.locator('.react-flow__node[data-id="source"]').boundingBox())!;
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2, source.y - target.height, { steps: 15 });
  await page.mouse.up();
  await cameraAtRest(page);
  const routed = await ends(page);
  const from = (await page.locator('.react-flow__node[data-id="source"]').boundingBox())!;
  const to = (await page.locator('.react-flow__node[data-id="near"]').boundingBox())!;
  expect(routed.from.y).toBeCloseTo(from.y, 1);
  expect(routed.to.y).toBeCloseTo(to.y + to.height, 1);
  expect(routed.from.x).toBeCloseTo(routed.to.x, 1);
});
