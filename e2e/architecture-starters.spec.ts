import { expect, test, type Page } from '@playwright/test';

/**
 * Architecture Starters, driven the way they are meant to be used: ⌘K, a few letters, Enter, and a
 * diagram to talk about. The keyboard path is the product claim, so it is the one asserted first.
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

test.describe('architecture starters', () => {
  test('⌘K, "microservices", Enter — and the whole thing undoes in one step', async ({ page }) => {
    await newCanvas(page, 'Starter keyboard');

    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('microservices');
    // Distinct from an ordinary command, and described in one line.
    const row = page.getByRole('option', { selected: true });
    await expect(row).toContainText('Microservices');
    await expect(row).toContainText('Architectures');
    await page.keyboard.press('Enter');

    await expect(page.locator('.dc-node')).toHaveCount(12);
    // Selected, so the next thing typed acts on what was just inserted.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(12);
    await expect(page.locator('.dc-status-right')).toContainText('12 elements · 9 connections');

    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.locator('.dc-node')).toHaveCount(12);
  });

  test('every starter is reachable by the words people actually type', async ({ page }) => {
    await newCanvas(page, 'Starter search');
    for (const [query, expected] of [
      ['monolith', 'Monolith'],
      ['modular', 'Modular Monolith'],
      ['event driven', 'Event-Driven'],
      ['ports and adapters', 'Hexagonal'],
    ] as const) {
      await page.keyboard.press('ControlOrMeta+k');
      await page.keyboard.type(query);
      await expect(page.getByRole('option', { selected: true })).toContainText(expected);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
    }
  });

  test('a route rule on the gateway fan is edited in place — double-click the chip, type, Enter', async ({
    page,
  }) => {
    await newCanvas(page, 'Editable route rule');
    await insertViaPalette(page, 'microservices');
    await page.locator('.dc-canvas, .react-flow').first().click({ position: { x: 20, y: 20 } });

    const chip = page.locator('.dc-edge-condition', { hasText: '/payments/*' });
    await expect(chip).toHaveCount(1);
    await chip.dblclick();
    const input = page.locator('.dc-edge-condition-input');
    await expect(input).toBeVisible();
    await input.fill('/payments/v2/*');
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-edge-condition', { hasText: '/payments/v2/*' })).toHaveCount(1);
    await expect(page.locator('.dc-edge-condition-input')).toHaveCount(0);
  });

  test('the blank canvas offers them too, and stops offering once there is anything', async ({
    page,
  }) => {
    await newCanvas(page, 'Starter empty state');
    const starters = page.getByRole('group', { name: 'Starters' });
    await expect(starters).toBeVisible();

    await starters.getByRole('button', { name: 'Event-Driven' }).click();
    await expect(page.locator('.dc-node')).toHaveCount(11);
    await expect(starters).toBeHidden();
  });

  test('a second starter lands clear of the first, and both survive a reload', async ({ page }) => {
    await newCanvas(page, 'Starter twice');
    await insertViaPalette(page, 'microservices');
    await expect(page.locator('.dc-node')).toHaveCount(12);
    await insertViaPalette(page, 'microservices');
    await expect(page.locator('.dc-node')).toHaveCount(24);

    // The two blocks occupy disjoint horizontal ranges in document space — nothing was dropped on
    // top of anything, and nothing already on the canvas moved to make room.
    const spans = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.react-flow__node')].map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      boxes.sort((a, b) => a.left - b.left);
      return boxes;
    });
    expect(spans.length).toBe(24);
    const firstBlockRight = Math.max(...spans.slice(0, 12).map((box) => box.right));
    const secondBlockLeft = Math.min(...spans.slice(12).map((box) => box.left));
    expect(secondBlockLeft).toBeGreaterThan(firstBlockRight);

    // A reload lands back in the library, the same way `critical-journey.spec.ts` re-opens.
    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'Starter twice' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    await expect(page.locator('.dc-node')).toHaveCount(24);
  });
});
