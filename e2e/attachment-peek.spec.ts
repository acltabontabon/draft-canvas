import { expect, test } from '@playwright/test';
import { edgeMidpoint } from './canvas';

/**
 * Notes at a glance: while editing, the shape or connector the pointer rests on tells its notes and code in the
 * presentation callout — no click — and steps aside for anything deliberate. The example's `orders`
 * queue carries one note; `Orders API` carries nothing.
 */
test('resting on a shape tells its note, and a click puts it away', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try an example', exact: true }).click();
  const queue = page.locator('.react-flow__node').filter({ hasText: 'orders' }).filter({ has: page.locator('.dc-attachment-badge') });
  const peek = page.locator('.dc-callout[data-variant="peek"]:not([data-leaving])');
  await expect(queue).toBeVisible();

  await page.locator('.react-flow__node').filter({ hasText: 'Orders API' }).hover();
  await page.waitForTimeout(600);
  await expect(peek).toHaveCount(0);

  await queue.hover();
  await expect(peek).toBeVisible();
  await expect(peek).toHaveAccessibleName('Note on orders');
  await expect(peek).toContainText('The queue holds accepted work');
  // Nothing was selected or opened to show it.
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await expect(page.locator('.dc-attachment-popover')).toHaveCount(0);

  // The pointer can cross onto the callout to read it, and leaving lets it go.
  await peek.locator('.dc-callout-note').hover();
  await page.waitForTimeout(400);
  await expect(peek).toBeVisible();
  await page.mouse.move(40, 300);
  await expect(peek).toHaveCount(0);

  // A click is deliberate: the shape is selected and its inspector takes over.
  await queue.hover();
  await expect(peek).toBeVisible();
  await queue.click();
  await expect(peek).toHaveCount(0);
  await page.mouse.move(40, 300);
  await queue.hover();
  await page.waitForTimeout(600);
  await expect(peek).toHaveCount(0);
});

test('resting on a connector tells the code it carries', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try an example', exact: true }).click();
  const peek = page.locator('.dc-callout[data-variant="peek"]:not([data-leaving])');
  const line = page.locator('.dc-edge-line').nth(1);
  // A level connector's path has no height, which Playwright counts as hidden.
  await expect(line).toBeAttached();
  const mid = await edgeMidpoint(page, line);

  await page.mouse.click(mid.x, mid.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Attach code' }).click();
  await page.keyboard.type('await fulfil(order);');
  // Away from the card and every shape: keeps the code, then clears the selection.
  await page.mouse.click(mid.x, mid.y + 220);
  await page.mouse.click(mid.x, mid.y + 240);
  await expect(page.locator('.dc-attachment-card')).toHaveCount(0);

  await page.mouse.move(mid.x - 4, mid.y);
  await page.mouse.move(mid.x, mid.y);
  await expect(peek).toBeVisible();
  await expect(peek.locator('.dc-callout-code')).toContainText('await fulfil(order);');
  await expect(page.locator('.react-flow__edge.selected')).toHaveCount(0);

  await page.mouse.move(mid.x, mid.y + 240);
  await expect(peek).toHaveCount(0);
});
