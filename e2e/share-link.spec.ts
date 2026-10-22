import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas } from './canvas';
import { createReaderExample } from './reader-example';

/**
 * Read-only share links use the actual canvas, remain fixed, and never save a recipient copy.
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

test('a diagram without Flows opens in Focus view with the actual fixed shapes', async ({ page, context, browserName }, testInfo) => {
  await recordClipboardWrites(page);
  await newCanvas(page, 'Shared checkout');
  await create(page, 'Service', { x: 300, y: 300 });
  await create(page, 'Data Store', { x: 600, y: 300 });
  await expect(page.locator('.dc-node')).toHaveCount(2);
  const originalShape = await page.locator('.dc-node[data-type="database"] .dc-node-surface').innerHTML();
  await runCommand(page, 'Copy share link');
  const dialog = page.getByRole('dialog', { name: 'Export & share' });
  await expect(dialog.getByRole('checkbox', { name: /Require a passphrase/ })).toBeChecked();
  await dialog.getByRole('checkbox', { name: /Require a passphrase/ }).uncheck();
  await dialog.getByRole('button', { name: 'Copy share link', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedText ?? '')).toMatch(/#d=1\./);
  const link = await page.evaluate(() => window.__copiedText!);
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  const reader = await context.newPage();
  await reader.goto(link);
  await expect(reader.locator('.dc-shared-reader')).toBeVisible();
  await expect(reader.locator('.dc-shared-reader')).toHaveAttribute('data-reading-mode', 'focus');
  await expect(reader.getByRole('region', { name: 'Focus view' })).toBeVisible();
  await expect(reader.getByRole('heading', { name: 'Walkthrough', exact: true })).toHaveCount(0);
  await expect(reader.getByRole('region', { name: 'Flow walkthrough' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Play flow', exact: true })).toHaveCount(0);
  await expect(reader.getByRole('heading', { name: 'Shared checkout', exact: true })).toBeVisible();
  await expect(reader.locator('.dc-node')).toHaveCount(2);
  expect(await reader.locator('.dc-node[data-type="database"] .dc-node-surface').innerHTML()).toBe(originalShape);
  await expect(reader.getByRole('textbox', { name: 'Diagram title' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Make an editable copy' })).toHaveCount(0);
  await expect(reader.locator('.react-flow__node.draggable')).toHaveCount(0);
  await expect(reader.locator('.react-flow__resize-control')).toHaveCount(0);
  const before = await reader.evaluate(async () => JSON.stringify((await import('/src/store/editorStore.ts')).useEditorStore.getState().document.nodes));
  const shape = await reader.locator('.dc-node').first().boundingBox();
  await reader.mouse.move(shape!.x + shape!.width / 2, shape!.y + shape!.height / 2);
  await reader.mouse.down();
  await reader.mouse.move(shape!.x + 100, shape!.y + 75, { steps: 8 });
  await reader.mouse.up();
  expect(await reader.evaluate(async () => JSON.stringify((await import('/src/store/editorStore.ts')).useEditorStore.getState().document.nodes))).toBe(before);
  await reader.getByRole('button', { name: 'Fit diagram' }).click();
  await reader.locator('.dc-node').first().click();
  await expect(reader.getByRole('region', { name: 'Element details' })).toBeVisible();
  await reader.screenshot({ path: testInfo.outputPath('focus-reader.png') });
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.emulateMedia({ colorScheme: 'dark' });
  await reader.getByRole('button', { name: 'Contents', exact: true }).click();
  await expect(reader.getByRole('region', { name: 'Focus view' })).toBeVisible();
  await expect(reader.getByRole('heading', { name: 'Walkthrough', exact: true })).toHaveCount(0);
  await reader.getByRole('button', { name: 'Contents', exact: true }).click();
  await reader.keyboard.press('Delete');
  await reader.keyboard.press('s');
  await expect(reader.locator('.dc-node')).toHaveCount(2);
  await expect(reader).toHaveURL(/#d=1\./);
  await reader.getByRole('button', { name: 'Close shared diagram' }).click();
  await expect(reader.locator('.dc-editor')).toHaveCount(0);
  await expect(reader).not.toHaveURL(/#d=/);
});

test('a protected link unlocks locally, keeps the real diagram and relocks without retaining plaintext', async ({ page, context }, testInfo) => {
  await recordClipboardWrites(page);
  await newCanvas(page, 'Private architecture');
  await create(page, 'Service', { x: 300, y: 300 });
  await create(page, 'Data Store', { x: 600, y: 300 });
  await runCommand(page, 'Copy share link');
  const dialog = page.getByRole('dialog', { name: 'Export & share' });
  await dialog.getByLabel('Passphrase', { exact: true }).fill('copper river orbit lantern');
  await dialog.getByLabel('Confirm passphrase').fill('copper river orbit lantern');
  await dialog.screenshot({ path: testInfo.outputPath('share-export.png') });
  await dialog.getByRole('button', { name: 'Copy protected link' }).click();
  await expect.poll(() => page.evaluate(() => window.__copiedText ?? '')).toMatch(/#d=2\./);
  const link = await page.evaluate(() => window.__copiedText!);
  expect(link).not.toContain('copper');
  const reader = await context.newPage();
  const errors: string[] = [];
  reader.on('pageerror', (error) => errors.push(error.message));
  await reader.goto(link);
  await expect(reader.getByRole('button', { name: 'Unlock diagram' })).toBeVisible();
  await expect(reader.locator('.dc-node')).toHaveCount(0);
  await expect(reader.getByRole('heading', { name: 'Private architecture' })).toHaveCount(0);
  await reader.getByLabel('Passphrase', { exact: true }).fill('wrong phrase');
  await reader.getByRole('button', { name: 'Unlock diagram' }).click();
  await expect(reader.locator('.dc-share-unlock').getByRole('alert')).toContainText('Incorrect passphrase');
  await expect(reader.locator('.dc-node')).toHaveCount(0);
  await reader.getByLabel('Passphrase', { exact: true }).fill('copper river orbit lantern');
  await reader.getByRole('button', { name: 'Unlock diagram' }).click();
  await expect(reader.locator('.dc-shared-reader')).toBeVisible();
  await expect(reader.locator('.dc-node[data-type="database"]')).toHaveCount(1);
  await expect(reader.getByText('Passphrase protected', { exact: true })).toBeVisible();
  await reader.screenshot({ path: testInfo.outputPath('guided-reader.png') });
  await reader.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(reader.getByRole('button', { name: 'Unlock diagram' })).toBeVisible();
  await expect(reader).toHaveTitle('Protected diagram — Draft Canvas');
  expect(await reader.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.nodes.length)).toBe(0);
  await reader.getByLabel('Passphrase', { exact: true }).fill('copper river orbit lantern');
  await reader.getByRole('button', { name: 'Unlock diagram' }).click();
  await expect(reader.locator('.dc-node')).toHaveCount(2);
  await reader.setViewportSize({ width: 390, height: 844 });
  await reader.emulateMedia({ colorScheme: 'dark' });
  await expect(reader.getByRole('button', { name: 'Contents', exact: true })).toBeVisible();
  await expect.poll(() => reader.locator('.dc-reader-canvas').evaluate((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    return Array.from(canvas.querySelectorAll('.dc-node')).every((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom;
    });
  })).toBe(true);
  expect(await reader.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await reader.screenshot({ path: testInfo.outputPath('guided-reader-mobile-dark.png') });
  expect(errors).toEqual([]);
});

test('a damaged link is refused and lands on the Library', async ({ page }) => {
  await page.goto('/#d=1.not-a-real-payload');
  await expect(page.locator('.dc-editor')).toHaveCount(0);
  await expect(page.getByText(/could not be opened/)).toBeVisible();
  await expect(page).not.toHaveURL(/#d=/);
});

test('a protected link opens Guided reader even when the clipboard silently drops the write', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  });
  await newCanvas(page, 'Protected example');
  await create(page, 'Service', { x: 300, y: 300 });
  await runCommand(page, 'Copy share link');
  const dialog = page.getByRole('dialog', { name: 'Export & share' });
  await dialog.getByLabel('Passphrase', { exact: true }).fill('canvas-lantern-river-47');
  await dialog.getByLabel('Confirm passphrase').fill('canvas-lantern-river-47');
  await dialog.getByRole('button', { name: 'Copy protected link' }).click();
  const link = dialog.getByRole('link', { name: 'Open Guided reader' });
  await expect(link).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Share link', exact: true })).toHaveValue(/#d=2\./);
  await dialog.screenshot({ path: testInfo.outputPath('generated-protected-link.png') });
  const [reader] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await reader.bringToFront();
  await expect(reader.getByRole('heading', { name: 'Shared with you' })).toBeVisible();
  await reader.getByLabel('Passphrase', { exact: true }).fill('canvas-lantern-river-47');
  await reader.getByRole('button', { name: 'Unlock diagram' }).click();
  await expect(reader.getByRole('heading', { name: 'Protected example', exact: true })).toBeVisible();
  await expect(reader.locator('.dc-shared-reader .dc-node')).toHaveCount(1);
});

for (const withFlow of [false, true]) {
  test(`${withFlow ? 'Guided reader' : 'Focus view'} browses refined attachments across levels without changing the diagram`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const file = createReaderExample(withFlow);
    file.edges[0]!.attachments = [{ id: 'at-reader-code', type: 'code', language: 'javascript', code: Array.from({ length: 30 }, (_, index) => `accept(order); // ${index + 1}`).join('\n') }];
    if (withFlow) {
      const base = file.flows[0]!;
      file.flows.push({ ...base, id: 'reader-retry-flow', title: 'Retry processing', steps: base.steps.slice(1).map((step, index) => ({ ...step, id: `reader-retry-step-${index}` })) });
    }
    const url = await page.evaluate(async (file) => {
      const { encodeShareLink } = await import('/src/share/link.ts');
      const result = await encodeShareLink(file, location.href);
      if (!('url' in result)) throw new Error('Expected a link');
      return result.url;
    }, file);
    await page.goto(url);
    await expect(page.locator('.dc-shared-reader')).toHaveAttribute('data-reading-mode', withFlow ? 'guided' : 'focus');
    await expect(page.getByRole('complementary', { name: 'Diagram contents' })).toBeHidden();
    const canvas = page.locator('.dc-reader-canvas');
    const fullCanvas = (await canvas.boundingBox())!;
    expect(fullCanvas.width).toBeGreaterThan(page.viewportSize()!.width * 0.9);
    await page.getByRole('button', { name: 'Contents', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Diagram levels' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: 'Diagram contents' })).toBeHidden();
    const before = await page.evaluate(async () => {
      const { fileOf, useEditorStore } = await import('/src/store/editorStore.ts');
      const { nodes, edges, flows, openPoints } = fileOf(useEditorStore.getState());
      return JSON.stringify({ nodes, edges, flows, openPoints });
    });
    if (withFlow) {
      const chooseSteps = page.getByRole('button', { name: 'Browse walkthrough steps', exact: true });
      await chooseSteps.click();
      await page.getByRole('combobox', { name: 'Flow', exact: true }).selectOption({ label: 'Retry processing' });
      await expect(page.locator('.dc-reader-position')).toHaveText('2 steps');
      await expect(page.getByRole('button', { name: 'Start walkthrough', exact: true })).toBeVisible();
      await chooseSteps.click();
      await page.getByRole('combobox', { name: 'Flow', exact: true }).selectOption({ label: file.flows[0]!.title });
      await expect(page.locator('.dc-reader-position')).toHaveText('3 steps');
      await chooseSteps.click();
      await expect(page.getByRole('region', { name: 'Walkthrough steps' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('region', { name: 'Walkthrough steps' })).toHaveCount(0);
      await expect(chooseSteps).toBeFocused();
    }
    await expect(page.getByRole('button', { name: /^Context/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Attachments on Orders API → orders', exact: true }).click();
    const codeCard = page.locator('.dc-reader-attachment-card');
    await expect(codeCard).toContainText('accept(order); // 30');
    await expect(codeCard.locator('.dc-reader-attachment-text')).toHaveAttribute('tabindex', '0');
    await codeCard.getByRole('button', { name: 'Close attachment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Attachments on Orders API → orders', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Attachments on Orders API', exact: true }).click();
    const card = page.locator('.dc-reader-attachment-card');
    await expect(card).toContainText('Acknowledge an accepted order before background processing begins.');
    expect((await canvas.boundingBox())!.width).toBeGreaterThan(page.viewportSize()!.width * 0.9);
    await expect(page.locator('.dc-reader-attachment-card')).toHaveCount(1);
    await card.getByRole('button', { name: 'Next attachment', exact: true }).click();
    await expect(card).toContainText('The queue holds accepted work');
    await card.getByRole('button', { name: 'Next attachment', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().path.length)).toBe(1);
    await expect(card).toContainText('Keep the order contract small:');
    await card.getByRole('button', { name: 'Next attachment', exact: true }).click();
    await expect(card).toContainText('Use idempotent writes so retries cannot create a second order.');
    await expect.poll(() => page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().path.length)).toBe(0);
    await expect(page.locator('.dc-reader-attachment-marker[aria-expanded="true"]')).toHaveCount(1);
    const diagram = (await canvas.boundingBox())!;
    const detail = (await card.boundingBox())!;
    expect(detail.x).toBeGreaterThanOrEqual(diagram.x);
    expect(detail.x + detail.width).toBeLessThanOrEqual(diagram.x + diagram.width);
    expect(detail.y).toBeGreaterThanOrEqual(diagram.y);
    expect(detail.y + detail.height).toBeLessThanOrEqual(diagram.y + diagram.height);
    await page.screenshot({ path: testInfo.outputPath('reader-placement-check.png') });
    // Browsing may still be framing the destination room; judge the settled placement.
    await expect.poll(() => canvas.evaluate((element) => {
      const detail = element.querySelector('.dc-reader-attachment-card')?.getBoundingClientRect();
      if (!detail) return false;
      return [...element.querySelectorAll('.dc-node')].every((shape) => {
        const bounds = shape.getBoundingClientRect();
        return Math.min(detail.right, bounds.right) <= Math.max(detail.left, bounds.left) || Math.min(detail.bottom, bounds.bottom) <= Math.max(detail.top, bounds.top);
      });
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('reader-refined-attachments.png') });
    await page.getByRole('button', { name: 'Attachments on Orders database', exact: true }).click();
    await expect(card).toContainText('Awaiting input');
    await expect(card).toContainText('Confirm how long completed orders should be retained.');
    await card.getByRole('button', { name: 'Next attachment', exact: true }).click();
    await expect(card).toContainText('Resolved');
    await expect(card).toContainText('The API assigns UUIDs before publishing work.');
    await card.getByRole('button', { name: 'Close attachment', exact: true }).click();
    await expect(card).toHaveCount(0);
    if (withFlow) {
      await page.getByRole('button', { name: 'Start walkthrough', exact: true }).click();
      await expect(page.locator('.dc-reader-position')).toHaveText('1 / 3');
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.locator('.dc-reader-position')).toHaveText('2 / 3');
      await expect(card).toContainText('Use idempotent writes');
      await expect(page.locator('.dc-callout')).toHaveCount(0);
      await page.getByRole('button', { name: 'Browse walkthrough steps', exact: true }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('region', { name: 'Walkthrough steps' })).toHaveCount(0);
      await expect(card).toBeVisible();
    } else {
      await page.getByRole('button', { name: 'Attachments', exact: true }).click();
      await expect(card).toBeVisible();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('.dc-reader-attachment-dock .dc-reader-attachment-card')).toBeVisible();
    const canvasBounds = (await canvas.boundingBox())!;
    const cardBounds = (await card.boundingBox())!;
    expect(cardBounds.y).toBeGreaterThanOrEqual(canvasBounds.y + canvasBounds.height - 1);
    expect(await card.evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true);
    if (withFlow) {
      const controls = (await page.getByRole('region', { name: 'Flow walkthrough' }).boundingBox())!;
      expect(controls.y).toBeGreaterThanOrEqual(cardBounds.y + cardBounds.height);
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(page.locator('.dc-reader-position')).toHaveText('3 / 3');
      await expect(card).toContainText('Confirm how long completed orders should be retained.');
      await expect(page.getByRole('button', { name: 'Finish', exact: true })).toBeVisible();
    }
    await card.getByRole('button', { name: 'Next attachment', exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('reader-refined-attachments-mobile-dark.png') });
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    const after = await page.evaluate(async () => {
      const { fileOf, useEditorStore } = await import('/src/store/editorStore.ts');
      const { nodes, edges, flows, openPoints } = fileOf(useEditorStore.getState());
      return JSON.stringify({ nodes, edges, flows, openPoints });
    });
    expect(after).toBe(before);
  });
}

test('link preparation stays responsive and can be cancelled while the local worker loads', async ({ page }, testInfo) => {
  await recordClipboardWrites(page);
  await newCanvas(page, 'Local compression');
  await create(page, 'Service', { x: 300, y: 300 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/src/share/compression.worker.ts*', async (route) => {
    await gate;
    await route.continue().catch(() => {}); // Cancellation can terminate the requesting worker.
  });
  try {
    await runCommand(page, 'Copy share link');
    const dialog = page.getByRole('dialog', { name: 'Export & share' });
    await dialog.getByLabel('Passphrase', { exact: true }).fill('canvas-lantern-river-47');
    await dialog.getByLabel('Confirm passphrase').fill('canvas-lantern-river-47');
    await dialog.getByRole('button', { name: 'Copy protected link' }).click();
    await expect(dialog.getByRole('progressbar', { name: 'Preparing share link' })).toBeVisible();
    await expect(dialog.getByText('Everything stays on this device.', { exact: true })).toBeVisible();
    await dialog.screenshot({ path: testInfo.outputPath('share-local-progress.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog.getByRole('progressbar')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Copy protected link' })).toBeEnabled();
    expect(await page.evaluate(() => window.__copiedText)).toBeUndefined();
    release();
    await dialog.getByRole('button', { name: 'Copy protected link' }).click();
    await expect(dialog.getByRole('link', { name: 'Open Guided reader' })).toBeVisible();
    await expect(dialog.getByText(/characters · self-contained link/)).toBeVisible();
    await dialog.screenshot({ path: testInfo.outputPath('share-compact-ready.png') });
  } finally {
    release();
  }
});
