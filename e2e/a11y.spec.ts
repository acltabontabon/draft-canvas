import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { newCanvas } from './canvas';

/**
 * axe over the surfaces people spend their time in: the Library, the editor holding a real diagram,
 * the export dialog, the command palette and the Outline. Serious and critical violations fail the
 * run; moderate and minor ones are reported in the trace, not enforced — the WCAG floor this holds is
 * names, roles, contrast and structure, not every best-practice note.
 *
 * Rules disabled, and why:
 * - `color-contrast` inside the diagram itself (`.react-flow__renderer`): a shape's text sits on an
 *   SVG fill axe cannot resolve, so it samples the label against the canvas behind it and reports
 *   contrast that is not what anyone sees. The diagram's own colours are held to their floors in
 *   `tests/theme-contrast.test.ts`, from the tokens. Everything else about the diagram's markup —
 *   names, roles, structure — is still scanned; only that one rule skips that one subtree, which
 *   axe cannot express in a single pass, hence the two below.
 */
const ENFORCED = new Set(['serious', 'critical']);

async function scan(page: Page, where: string) {
  // Panels and dialogs fade in. Sampled mid-fade, every colour is a blend of the panel and what is
  // behind it, and axe reports contrast failures that exist for 140 ms.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];
  const structure = await new AxeBuilder({ page }).withTags(tags).disableRules(['color-contrast']).analyze();
  const contrast = await new AxeBuilder({ page }).withRules(['color-contrast']).exclude('.react-flow__renderer').analyze();
  const failing = [...structure.violations, ...contrast.violations].filter(
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
    await expect(page.getByRole('button', { name: 'New canvas' })).toBeVisible();
    await scan(page, 'Library');
  });

  test('the editor with a starter, its export dialog, the command palette and the Outline', async ({ page }) => {
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

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
    await scan(page, 'command palette');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await scan(page, 'export dialog');
  });
});

test.describe('accessibility (axe), dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('the editor with a starter and the Outline', async ({ page }) => {
    await newCanvas(page, 'axe editor dark');
    const starters = page.getByRole('group', { name: 'Suggested starters', exact: true });
    await starters.getByRole('button', { name: 'Start from Event-Driven', exact: true }).click();
    await expect(page.locator('.dc-node').first()).toBeVisible();
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('Alt+o');
    await expect(page.getByRole('complementary', { name: 'Outline' })).toBeVisible();
    await scan(page, 'editor, dark');
  });
});
