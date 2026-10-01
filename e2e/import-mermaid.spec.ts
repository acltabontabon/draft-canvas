import { expect, test, type Page } from '@playwright/test';
import { newCanvas } from './canvas';

/**
 * Getting a Mermaid flowchart in: pasted onto an open canvas it lands in that room as one undo
 * step; picked or dropped as a file it opens from the Library as its own diagram.
 */

const FLOWCHART = `flowchart LR
  user((Customer)) -->|places order| api[Order API]
  api --> q[[Order queue]]
  q -.-> worker[Fulfilment worker]
  worker --> db[(Orders)]
  classDef hot fill:#f96
`;

const shape = (page: Page, label: string) => page.locator('.dc-node', { hasText: label });

/** The flowchart as text, the way a native paste event or a text drop carries it. */
function dispatchText(page: Page, type: 'paste' | 'drop', text: string) {
  return page.evaluate(
    ([eventType, body]) => {
      const data = new DataTransfer();
      data.setData('text/plain', body!);
      const target = document.querySelector('.dc-canvas')!;
      const event =
        eventType === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    },
    [type, text] as const,
  );
}

test.describe('importing a Mermaid flowchart', () => {
  test('pasted onto a canvas, it lands in the room as one undo step, selected', async ({ page }) => {
    await newCanvas(page, 'Mermaid paste');
    await expect(page.locator('.dc-node')).toHaveCount(0);

    await dispatchText(page, 'paste', FLOWCHART);

    await expect(page.locator('.dc-node')).toHaveCount(5);
    for (const label of ['Customer', 'Order API', 'Order queue', 'Fulfilment worker', 'Orders']) {
      await expect(shape(page, label)).toHaveCount(1);
    }
    await expect(page.locator('.dc-edge-line')).toHaveCount(4);
    await expect(page.locator('.dc-toast-message')).toContainText("1 thing Mermaid said that Draft Canvas doesn't draw: classDef");

    // One step: the whole flowchart, not shape by shape.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.locator('.dc-node')).toHaveCount(5);
  });

  test('pasted text that is not a flowchart is still nothing to paste', async ({ page }) => {
    await newCanvas(page, 'Not Mermaid');
    await dispatchText(page, 'paste', 'graphics are nice, but this is prose');
    await expect(page.locator('.dc-toast-message')).toContainText('Nothing to paste');
    await expect(page.locator('.dc-node')).toHaveCount(0);
  });

  test('dropped onto a canvas as text, it lands the same way', async ({ page }) => {
    await newCanvas(page, 'Mermaid drop');
    await dispatchText(page, 'drop', 'graph TD; A[Start] --> B{Ok?}; B -->|yes| C[(Store)]');
    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(shape(page, 'Ok?')).toHaveCount(1);
  });

  test('a .mmd file picked in the Library opens as a diagram named after the file', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[type="file"]', {
      name: 'checkout.mmd',
      mimeType: 'text/plain',
      buffer: Buffer.from(FLOWCHART),
    });
    await expect(page.locator('.dc-editor')).toBeVisible();
    await expect(page.getByLabel('Diagram title')).toHaveValue('checkout');
    await expect(page.locator('.dc-node')).toHaveCount(5);
    await expect(shape(page, 'Order queue')).toHaveCount(1);
    await expect(page.locator('.dc-toast-message')).toContainText('classDef');
  });

  test('a Markdown file with a mermaid fence imports the fenced chart', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('input[type="file"]', {
      name: 'design-notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from(`# Design\n\nProse.\n\n\`\`\`mermaid\nflowchart TD\n  A[Web] --> B[(DB)]\n\`\`\`\n`),
    });
    await expect(page.locator('.dc-editor')).toBeVisible();
    await expect(page.locator('.dc-node')).toHaveCount(2);
    await expect(shape(page, 'Web')).toHaveCount(1);
  });

  test('a file dropped onto the Library imports it', async ({ page }) => {
    await page.goto('/');
    // Dropped on the one control both the first-run screen and the Library proper have, so the
    // event bubbles up through whichever of the two is the drop zone.
    await page.getByRole('button', { name: 'New canvas' }).evaluate((target, text) => {
      const data = new DataTransfer();
      data.items.add(new File([text], 'dropped.mmd', { type: 'text/plain' }));
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, 'graph LR\n  A[One] --> B[Two]');
    await expect(page.locator('.dc-editor')).toBeVisible();
    await expect(page.getByLabel('Diagram title')).toHaveValue('dropped');
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });
});
