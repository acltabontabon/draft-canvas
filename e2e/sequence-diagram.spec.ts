import { expect, test, type Page } from '@playwright/test';

/**
 * Sequence Diagram: a derived, read-only lens over a Flow — opened via the toolbar or ⌘K, never
 * mutating the document, never entering undo history.
 */

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

async function insertViaPalette(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
}

/** Selects and opens the Sequence Diagram for one flow via ⌘K's two-step command. */
async function openSequenceDiagramViaPalette(page: Page, flowQuery: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('sequence diagram');
  await page.keyboard.press('Enter');
  await page.keyboard.type(flowQuery);
  await page.keyboard.press('Enter');
}

test.describe('Sequence Diagram', () => {
  test('opens from the toolbar for the active flow, renders participants and messages', async ({ page }) => {
    await newCanvas(page, 'Sequence — toolbar');
    await insertViaPalette(page, 'cqrs');

    // Make "Submit command" the active flow, then use the toolbar button.
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('switch to flow');
    await page.keyboard.press('Enter');
    await page.keyboard.type('submit command');
    await page.keyboard.press('Enter');

    const button = page.getByTitle('Sequence Diagram');
    await expect(button).toBeEnabled();
    await button.click();

    const dialog = page.getByRole('dialog', { name: 'Sequence Diagram' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dc-sequence-svg')).toBeVisible();
    // CQRS's "Submit command" flow has 6 steps across 5 distinct participants.
    await expect(dialog.locator('.dc-sequence-svg text')).not.toHaveCount(0);
  });

  test('opens with a specific flow already selected, straight from ⌘K', async ({ page }) => {
    await newCanvas(page, 'Sequence — palette');
    await insertViaPalette(page, 'cqrs');
    await openSequenceDiagramViaPalette(page, 'submit command');

    const dialog = page.getByRole('dialog', { name: 'Sequence Diagram' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.dc-sequence-svg')).toBeVisible();
  });

  test('the source view shows recognizable Mermaid and PlantUML text, and both are copyable', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await newCanvas(page, 'Sequence — source');
    await insertViaPalette(page, 'cqrs');
    await openSequenceDiagramViaPalette(page, 'submit command');

    const dialog = page.getByRole('dialog', { name: 'Sequence Diagram' });
    await dialog.getByLabel('View').selectOption('source');
    await expect(dialog.locator('.dc-sequence-source')).toContainText('sequenceDiagram');
    await expect(dialog.locator('.dc-sequence-source')).toContainText('participant');

    await dialog.getByRole('button', { name: /Copy Mermaid/i }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('sequenceDiagram');

    await dialog.getByLabel('Format').selectOption('plantuml');
    await expect(dialog.locator('.dc-sequence-source')).toContainText('@startuml');
    await dialog.getByRole('button', { name: /Copy PlantUML/i }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('@startuml');
  });

  test('Escape closes it, and the canvas is exactly as it was — no mutation, no undo entry', async ({ page }) => {
    await newCanvas(page, 'Sequence — no mutation');
    await insertViaPalette(page, 'cqrs');
    const nodeCount = await page.locator('.dc-node').count();
    const edgeCount = await page.locator('.dc-edge').count();

    await openSequenceDiagramViaPalette(page, 'submit command');
    const dialog = page.getByRole('dialog', { name: 'Sequence Diagram' });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(nodeCount);
    await expect(page.locator('.dc-edge')).toHaveCount(edgeCount);

    // Opening the palette, selecting a flow, opening the Sequence Diagram, and closing it are all
    // non-editorial — the only real document edit in this test is the starter insert itself, so a
    // single Undo must revert cleanly to an empty canvas. If the dialog had pushed even one
    // spurious history entry, this same keypress would land somewhere else instead.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(0);
    await expect(page.locator('.dc-edge')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.locator('.dc-node')).toHaveCount(nodeCount);
    await expect(page.locator('.dc-edge')).toHaveCount(edgeCount);
  });

  test('the toolbar button is disabled with no flow selected', async ({ page }) => {
    await newCanvas(page, 'Sequence — disabled');
    await insertViaPalette(page, 'cqrs');
    // Fresh insert leaves no flow lens active — "Diagram" is the default.
    await expect(page.getByTitle('Sequence Diagram')).toBeDisabled();
  });
});
