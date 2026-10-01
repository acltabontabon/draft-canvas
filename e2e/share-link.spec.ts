import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas } from './canvas';

/**
 * Read-only share links: the whole diagram in the fragment, opened without being saved, and turned
 * into a diagram of your own with one click.
 */

// Only Chromium knows these permissions (WebKit refuses to open a context with them), so the real
// clipboard is read back there; everywhere, the text handed to `writeText` is recorded first.
test.use({
  permissions: async ({ browserName }, provide) => {
    await provide(browserName === 'chromium' ? ['clipboard-read', 'clipboard-write'] : []);
  },
});

declare global {
  interface Window {
    __copiedText?: string;
  }
}

async function recordClipboardWrites(page: Page) {
  await page.addInitScript(() => {
    // Wrapped on the prototype, so `readText` and the rest of the real clipboard stay as they are.
    const proto = Object.getPrototypeOf(navigator.clipboard) as { writeText: (text: string) => Promise<void> };
    const original = proto.writeText;
    proto.writeText = async function (this: Clipboard, text: string) {
      window.__copiedText = text;
      return original.call(this, text);
    };
  });
}

async function runCommand(page: Page, title: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
  await page.keyboard.type(title);
  await expect(page.getByRole('option', { selected: true })).toContainText(title);
  await page.keyboard.press('Enter');
}

test('a share link opens read-only elsewhere, and a copy of it becomes an editable diagram', async ({
  page,
  context,
  browserName,
}) => {
  await recordClipboardWrites(page);
  await newCanvas(page, 'Shared checkout');
  await create(page, 'Service', { x: 300, y: 300 });
  await create(page, 'Data Store', { x: 600, y: 300 });
  await expect(page.locator('.dc-node')).toHaveCount(2);
  await expect(page.locator('.dc-save')).toContainText('Saved locally');

  await runCommand(page, 'Copy share link');
  const link = await page.evaluate(() => window.__copiedText ?? '');
  expect(link).toMatch(/#d=1\.[A-Za-z0-9_-]+$/);
  if (browserName === 'chromium') {
    await expect(page.getByText('Link copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  }

  // Another tab, as a reader: the diagram is there, and so is the notice.
  const reader = await context.newPage();
  await reader.goto(link);
  await expect(reader.locator('.dc-editor')).toBeVisible();
  await expect(reader.locator('.dc-node')).toHaveCount(2);
  await expect(reader.getByText('Shared diagram — read only')).toBeVisible();
  await expect(reader.getByLabel('Diagram title')).toHaveValue('Shared checkout');
  await expect(reader.getByLabel('Diagram title')).toHaveAttribute('aria-disabled', 'true');
  await expect(reader.getByRole('button', { name: 'Service', exact: true })).toHaveCount(0);

  // Nothing changes it: the single-key shortcut still arms, but the store refuses the shape; a
  // rename is refused the same way.
  await reader.locator('.react-flow__pane').click({ position: { x: 150, y: 150 } });
  await reader.keyboard.press('s');
  await reader.locator('.react-flow__pane').click({ position: { x: 200, y: 500 } });
  await expect(reader.locator('.dc-node')).toHaveCount(2);
  await reader.locator('.dc-node').first().click();
  await reader.keyboard.press('Delete');
  await expect(reader.locator('.dc-node')).toHaveCount(2);
  // Not saved anywhere: the address still carries the link, not a library id.
  await expect(reader).toHaveURL(/#d=1\./);
  await expect(reader).not.toHaveURL(/doc=/);

  // The copy is an ordinary diagram: editable, saved, and listed in the Library.
  await reader.getByRole('button', { name: 'Make an editable copy' }).click();
  await expect(reader.getByText('Shared diagram — read only')).toHaveCount(0);
  await expect(reader).toHaveURL(/#doc=/);
  await expect(reader).not.toHaveURL(/d=1\./);
  await expect(reader.getByRole('button', { name: 'Service', exact: true })).toBeVisible();
  await create(reader, 'Queue', { x: 450, y: 500 });
  await expect(reader.locator('.dc-node')).toHaveCount(3);
  await expect(reader.locator('.dc-save')).toContainText('Saved locally');

  await reader.getByRole('button', { name: 'Back to your diagrams' }).click();
  await expect(reader.locator('.dc-editor')).toHaveCount(0);
  await expect(reader.getByText('Shared checkout')).toHaveCount(2);
});

test('a damaged link is refused and lands on the Library', async ({ page }) => {
  await page.goto('/#d=1.not-a-real-payload');
  await expect(page.locator('.dc-editor')).toHaveCount(0);
  await expect(page.getByText(/could not be opened/)).toBeVisible();
  await expect(page).not.toHaveURL(/#d=/);
});
