import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { installMockShell } from './mockShell';

/**
 * Use in docs on the desktop: the picture is written beside the diagram's file, added to a Markdown
 * file the person picks — once, and only added — and redrawn when the diagram is saved. The shell is
 * the in-page fake (`mockShell.ts`); `src-tauri/src/docs.rs` has the disk's side of every rule.
 */

const README = `# Shop

The storefront and its services.

## Architecture

How a payment moves through the system.

## Running locally

npm start
`;

// `DOCS_SHOT_DIR` also captures the dialog at each stage, sharp enough for a guide.
if (process.env.DOCS_SHOT_DIR) test.use({ deviceScaleFactor: 2 });

test.beforeEach(async ({ page }) => {
  await installMockShell(page);
});

/** Payments: a gateway posting to a ledger, the ledger with a level inside. */
async function paymentsText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { createDocument, createEdge, createNode } = await import('/src/document/factory.ts');
    const { serializeDocument } = await import('/src/export/project.ts');
    const doc = createDocument('Payments');
    const gateway = createNode({ type: 'service', x: 0, y: 0, text: 'Gateway' });
    const store = createNode({ type: 'database', x: 0, y: 0, text: 'Entries' });
    const ledger = { ...createNode({ type: 'service', x: 280, y: 0, text: 'Ledger' }), inside: { nodes: [store], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } } };
    doc.nodes.push(gateway, ledger);
    doc.edges.push(createEdge({ source: gateway.id, target: ledger.id, label: 'posts entries' }));
    return serializeDocument(doc);
  });
}

async function openPayments(page: Page): Promise<string> {
  await page.goto('/');
  // An open event that beats host_ready is dropped; Home renders after that handshake.
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const text = await paymentsText(page);
  const handle = await page.evaluate((text) => window.__shell.addFile('payments', text), text);
  await page.evaluate((handle) => window.__shell.emit({ type: 'open', handle, name: 'payments', displayPath: '~/work/shop/docs/diagrams/payments.draftcanvas' }), handle);
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  return handle;
}

async function openUseInDocs(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('Use in docs');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Export & share' });
  await expect(dialog.getByRole('radio', { name: /Use in a README/ })).toBeChecked();
  return dialog;
}

async function shot(page: Page, name: string) {
  const dir = process.env.DOCS_SHOT_DIR;
  if (dir) await page.locator('.dc-modal-export').screenshot({ path: `${dir}/${name}.png` });
}

test('publishes beside the file, adds to a Markdown file once, and follows saves', async ({ page }) => {
  await openPayments(page);
  const dialog = await openUseInDocs(page);

  await expect(dialog.getByRole('status')).toHaveText('Not published');
  await expect(dialog.getByLabel('Markdown for this picture')).toHaveText('![Payments](payments.svg)');
  await shot(page, 'docs-desktop-unpublished');

  await dialog.getByRole('button', { name: 'Publish image' }).click();
  await expect(dialog.getByText('Published payments.svg')).toBeVisible();
  const published = await page.evaluate(() => window.__shell.docsImage('payments.svg'));
  expect(published).toContain('<metadata id="draftcanvas-docs">');
  expect(published).toContain('Ledger');
  expect(published).not.toContain('Entries');
  await expect(dialog.getByRole('status')).toHaveText('Up to date');

  // Choose the README two folders up: the path in the snippet is now from there.
  await page.evaluate((readme) => window.__shell.nextMarkdown({ name: 'README.md', text: readme, imageDir: 'docs/diagrams' }), README);
  await dialog.getByRole('button', { name: 'Add to a Markdown file…' }).click();
  await expect(dialog.getByLabel('Markdown for this picture')).toHaveText('![Payments](docs/diagrams/payments.svg)');
  await expect(dialog.getByRole('combobox', { name: 'Section' })).toHaveValue(/^line:/);
  await expect(dialog.locator('.dc-docs-page')).toContainText('How a payment moves through the system.');
  await shot(page, 'docs-desktop-markdown');
  const axe = await new AxeBuilder({ page }).include('.dc-modal-export').analyze();
  expect(axe.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
  // Keyboard: one Copy Markdown, reachable without a pointer.
  await expect(dialog.getByRole('button', { name: 'Copy Markdown' })).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Copy Markdown' }).focus();
  await expect(dialog.getByRole('button', { name: 'Copy Markdown' })).toBeFocused();

  await dialog.getByRole('button', { name: 'Add to README.md' }).click();
  await expect(dialog.getByText('Added to README.md')).toBeVisible();
  await shot(page, 'docs-desktop-added');
  const readme = await page.evaluate(() => window.__shell.markdown('README.md'));
  expect(readme).toBe(README.replace('## Running locally', '![Payments](docs/diagrams/payments.svg)\n\n## Running locally'));
  // Again: nothing more to add.
  await expect(dialog.getByText('Already in README.md')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add to README.md' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeEnabled();
  // A changed choice is named as waiting for Update, not as the diagram going stale.
  await dialog.getByRole('checkbox', { name: 'Redraw on every save' }).uncheck();
  await expect(dialog.getByRole('status')).toHaveText('Not applied');
  await expect(dialog.getByRole('button', { name: 'Update payments.svg' })).toBeEnabled();
  await dialog.getByRole('checkbox', { name: 'Redraw on every save' }).check();
  await expect(dialog.getByRole('status')).toHaveText('Up to date');
  await dialog.getByRole('checkbox', { name: 'Transparent' }).check();
  await expect(dialog.getByRole('status')).toHaveText('Not applied');
  await dialog.getByRole('checkbox', { name: 'Transparent' }).uncheck();
  await expect(dialog.getByRole('status')).toHaveText('Up to date');

  await dialog.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Service', exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: { x: 500, y: 420 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => page.evaluate(() => window.__shell.docsImage('payments.svg'))).not.toBe(published);
  expect(await page.evaluate(() => window.__shell.docsImage('payments.svg'))).toContain('<metadata id="draftcanvas-docs">');
  // The README is never touched by a save.
  expect(await page.evaluate(() => window.__shell.markdown('README.md'))).toBe(readme);
});

test('leaves an SVG it did not make alone, and says why', async ({ page }) => {
  await openPayments(page);
  await page.evaluate(() => window.__shell.setDocsImage('payments.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'));
  const dialog = await openUseInDocs(page);
  await expect(dialog.getByRole('status')).toHaveText('Name taken');
  await expect(dialog.getByText('payments.svg wasn’t made by Draft Canvas, so it won’t be replaced.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'payments.svg is taken' })).toBeDisabled();
  // Nothing to add to a Markdown file while the picture can't be published.
  await expect(dialog.getByRole('button', { name: 'Choose file…' })).toHaveCount(0);
  expect(await page.evaluate(() => window.__shell.docsImage('payments.svg'))).toBe('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
});

test('gives each level its own picture, and puts the next one beside the first on the page', async ({ page }) => {
  await openPayments(page);
  const dialog = await openUseInDocs(page);
  await dialog.getByRole('button', { name: 'Publish image' }).click();
  await expect(dialog.getByText('Published payments.svg')).toBeVisible();

  const level = dialog.getByRole('combobox', { name: 'Level' });
  await level.selectOption({ label: 'Inside Ledger' });
  await expect(dialog.getByLabel('Markdown for this picture')).toHaveText('![Payments / Ledger](payments.ledger.svg)');
  await expect(dialog.getByRole('status')).toHaveText('Not published');
  await dialog.getByRole('button', { name: 'Publish image' }).click();
  await expect(dialog.getByText('Published payments.ledger.svg')).toBeVisible();
  const inside = await page.evaluate(() => window.__shell.docsImage('payments.ledger.svg'));
  expect(inside).toContain('Entries');
  expect(inside).not.toContain('Gateway');
  // The whole diagram's picture is its own file, untouched.
  expect(await page.evaluate(() => window.__shell.docsImage('payments.svg'))).toContain('Gateway');
  await expect(level.locator('option', { hasText: 'Whole diagram · published' })).toHaveCount(1);
  await expect(level.locator('option', { hasText: 'Inside Ledger · published' })).toHaveCount(1);

  // A README already showing the whole diagram: the level goes right after it.
  const readme = `# Shop\n\n## Architecture\n\n![Payments](docs/diagrams/payments.svg)\n\n## Running locally\n\nnpm start\n`;
  await page.evaluate((text) => window.__shell.nextMarkdown({ name: 'README.md', text, imageDir: 'docs/diagrams' }), readme);
  await dialog.getByRole('button', { name: 'Add to a Markdown file…' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Section' })).toHaveValue('after:4');
  await expect(dialog.getByRole('combobox', { name: 'Section' }).locator('option').first()).toHaveText('After payments.svg');
  await shot(page, 'docs-desktop-levels');
  await dialog.getByRole('button', { name: 'Add to README.md' }).click();
  await expect(dialog.getByText('Added to README.md')).toBeVisible();
  expect(await page.evaluate(() => window.__shell.markdown('README.md'))).toBe(
    readme.replace('payments.svg)\n\n', 'payments.svg)\n\n![Payments / Ledger](docs/diagrams/payments.ledger.svg)\n\n'),
  );

  // Reopened from the top level: the whole diagram's picture, current.
  await dialog.getByRole('button', { name: 'Close' }).click();
  const again = await openUseInDocs(page);
  await expect(again.getByRole('combobox', { name: 'Level' })).toHaveValue('');
  await expect(again.getByRole('status')).toHaveText('Up to date');
});
