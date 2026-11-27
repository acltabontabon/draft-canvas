import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { newCanvas, presentButton, toggleFlows } from './canvas';
import { serveStarterGallery } from './gallery';

/**
 * axe over the surfaces people spend their time in: the Library and Home, the editor holding a real
 * diagram, its context menu, Appearance, a presentation, the export dialog, the command palette and
 * the Outline. Serious and critical violations fail the run; moderate and minor ones are reported in
 * the trace, not enforced — the WCAG floor this holds is names, roles, contrast and structure, not
 * every best-practice note. Where a surface was found wanting on target size (WCAG 2.5.8),
 * its scan asks for that too (`targetSize`).
 *
 * Rules disabled, and why:
 * - `color-contrast` inside the diagram itself (`.react-flow__renderer`): a shape's text sits on an
 *   SVG fill axe cannot resolve, so it samples the label against the canvas behind it and reports
 *   contrast that is not what anyone sees. The diagram's own colours are held to their floors in
 *   `tests/theme-contrast.test.ts`, from the tokens. Everything else about the diagram's markup —
 *   names, roles, structure — is still scanned; only that one rule skips that one subtree, which
 *   axe cannot express in a single pass, hence the separate passes below.
 * - `target-size` inside the diagram, likewise: what is drawn there (an attachment chip, a badge)
 *   is as large as the zoom makes it, so the floor is the chrome's to hold.
 *
 * Left out in one engine: Firefox's page process crashes partway through axe's walk of the
 * Appearance panel ("Page crashed": Playwright's Firefox 159 with axe-core 4.14, on Linux CI and on
 * Windows, in most runs, and with axe run inside the page too). No single rule or part of the panel
 * brings it on alone, and nothing in the app throws. So in Firefox that panel sits out its own scan
 * (`skip`) while the rest of the page is scanned; Chromium and WebKit scan the panel, whose markup
 * is the same in every engine.
 */
const ENFORCED = new Set(['serious', 'critical']);

async function scan(page: Page, where: string, { targetSize = false, skip = [] as string[] } = {}) {
  // Panels and dialogs fade in. Sampled mid-fade, every colour is a blend of the panel and what is
  // behind it, and axe reports contrast failures that exist for 140 ms.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];
  const axe = () => skip.reduce((builder, selector) => builder.exclude(selector), new AxeBuilder({ page }));
  const structure = await axe().withTags(tags).disableRules(['color-contrast']).analyze();
  const contrast = await axe().withRules(['color-contrast']).exclude('.react-flow__renderer').analyze();
  // Presentation's step marks were 14 × 18px targets 4px apart.
  const targets = targetSize
    ? (await axe().withRules(['target-size']).exclude('.react-flow__renderer').analyze()).violations
    : [];
  const failing = [...structure.violations, ...contrast.violations, ...targets].filter(
    (violation) => violation.impact && ENFORCED.has(violation.impact),
  );
  // The summary is the assertion, so a failure reads as a list of selectors rather than axe's full
  // result objects.
  const report = failing
    .map(
      (v) =>
        `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
          .map((node) => `${node.target.join(' ')} — ${node.failureSummary?.split('\n')[1]?.trim() ?? ''}`)
          .join('\n  ')}`,
    )
    .join('\n');
  expect(report, where).toBe('');
}

test.describe('accessibility (axe)', () => {
  test('the Library', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Quick Draft' })).toBeVisible();
    // axe holds `landmark-one-main` only as moderate: Home had none.
    await expect(page.getByRole('main')).toHaveCount(1);
    await scan(page, 'Library');
  });

  test('Home with a diagram on its shelf', async ({ page }) => {
    // A card's name left out the "just now" it shows (label-content-name-mismatch).
    await newCanvas(page, 'axe home');
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await expect(page.locator('.dc-home-draft')).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    await scan(page, 'Home with a diagram');
  });

  test('the context menu, Appearance and a presentation', async ({ page, browserName }) => {
    await serveStarterGallery(page);
    await newCanvas(page, 'axe surfaces');
    const starters = page.getByRole('group', { name: 'Suggested starters', exact: true });
    await starters.getByRole('button', { name: 'Start from Event-Driven', exact: true }).click();
    await expect(page.locator('.dc-node').first()).toBeVisible();
    await page.locator('.dc-node').first().click();

    // From the keyboard, its first row comes highlighted: that row's shortcut hint is the one read.
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await scan(page, 'context menu');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Commands' });
    await expect(palette).toBeVisible();
    await page.keyboard.type('Appearance');
    await expect(palette.getByRole('option', { selected: true })).toContainText('Appearance');
    await page.keyboard.press('Enter');
    const appearance = page.getByRole('complementary', { name: 'Appearance', exact: true });
    await expect(appearance).toBeVisible();
    // Firefox crashes scanning this panel (see the top of this file).
    await scan(page, 'Appearance panel', { skip: browserName === 'firefox' ? ['.dc-style-panel'] : [] });
    await appearance.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(appearance).toBeHidden();

    // Its step marks are targets of their own (WCAG 2.5.8). The starter has several flows: Present
    // asks which.
    await presentButton(page).click();
    await page.getByRole('menu', { name: 'Present which flow?' }).getByRole('menuitemradio').first().click();
    await expect(page.locator('.dc-present-tick').first()).toBeVisible();
    await scan(page, 'presenting a flow', { targetSize: true });
  });

  test('the Starters dialog: asking, browsing and one starter up close', async ({ page }) => {
    await serveStarterGallery(page, { enabled: false });
    await newCanvas(page, 'axe starters');
    await page.getByRole('button', { name: /Browse the starters gallery/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Starters', exact: true });
    await expect(dialog.getByRole('button', { name: 'Load starters', exact: true })).toBeVisible();
    await scan(page, 'Starters, asking');
    await dialog.getByRole('button', { name: 'Load starters', exact: true }).click();
    await expect(dialog.locator('.dc-starters-grid .dc-starter').first()).toBeVisible();
    await scan(page, 'Starters, browsing');
    await dialog.getByRole('button', { name: /^CQRS\b/ }).click();
    await expect(dialog.getByRole('img', { name: 'The CQRS starter' })).toBeVisible();
    await scan(page, 'Starters, one starter');
  });

  test('the editor with a starter, its export dialog, the command palette and the Outline', async ({ page }) => {
    await serveStarterGallery(page);
    await newCanvas(page, 'axe editor');
    const starters = page.getByRole('group', { name: 'Suggested starters', exact: true });
    await expect(starters).toBeVisible();
    await starters.getByRole('button', { name: 'Start from Event-Driven', exact: true }).click();
    await expect(starters).toBeHidden();
    await expect(page.locator('.dc-node').first()).toBeVisible();
    // Select one shape so its popover and handles are up — the editor's busiest state.
    await page.locator('.dc-node').first().click();
    await scan(page, 'editor with a starter');

    await page.keyboard.press('Alt+o');
    await expect(page.getByRole('complementary', { name: 'Outline' })).toBeVisible();
    await scan(page, 'Outline panel');
    await page.keyboard.press('Alt+o');
    await expect(page.getByRole('complementary', { name: 'Outline' })).toBeHidden();

    // The Flows panel is a tree (a treeitem per flow, its steps a group it owns), scanned open on a
    // flow so the nested level is in the page: axe checks the required owned/parent roles.
    await toggleFlows(page);
    const flows = page.getByRole('tree', { name: 'Flows' });
    await expect(flows).toBeVisible();
    await flows.getByRole('treeitem', { level: 1 }).nth(1).locator('.dc-flow-expand').click();
    await expect(flows.getByRole('treeitem', { level: 2 }).first()).toBeVisible();
    await scan(page, 'Flows panel');
    await page.getByRole('region', { name: 'Flows' }).getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('tree', { name: 'Flows' })).toBeHidden();

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
    await scan(page, 'command palette');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await scan(page, 'export dialog');
  });
});

test.describe('accessibility (axe), dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('the editor with a starter and the Outline', async ({ page }) => {
    await serveStarterGallery(page);
    await newCanvas(page, 'axe editor dark');
    const starters = page.getByRole('group', { name: 'Suggested starters', exact: true });
    await starters.getByRole('button', { name: 'Start from Event-Driven', exact: true }).click();
    await expect(page.locator('.dc-node').first()).toBeVisible();
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('Alt+o');
    await expect(page.getByRole('complementary', { name: 'Outline' })).toBeVisible();
    await scan(page, 'editor, dark');

    // The context menu's highlighted row, where the shortcut hint was 3.7:1 in dark.
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu')).toBeVisible();
    await scan(page, 'context menu, dark');
  });
});
