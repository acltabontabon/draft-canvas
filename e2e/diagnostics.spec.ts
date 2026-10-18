import { expect, test } from '@playwright/test';

test('a diagnostic report is previewed locally and the downloaded bytes match the preview', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Troubleshooting' }).click();
  const preview = page.getByRole('textbox', { name: 'Diagnostic report contents' });
  await expect(preview).toBeVisible();
  const text = await preview.inputValue();
  expect(JSON.parse(text)).toMatchObject({ format: 1, events: [] });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download report' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('draft-canvas-diagnostics.json');
  const stream = await download.createReadStream();
  const parts: Buffer[] = [];
  for await (const part of stream!) parts.push(Buffer.from(part));
  expect(Buffer.concat(parts).toString('utf8')).toBe(text);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Troubleshooting' })).toBeFocused();
});

test('the editor opens diagnostics from More while About keeps only the licences link', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'About Draft Canvas' }).first().click();
  const about = page.getByRole('dialog', { name: 'About', exact: true });
  await expect(about.getByRole('link', { name: 'Licences' })).toHaveAttribute('href', './THIRD_PARTY_LICENSES.txt');
  await expect(about.getByRole('button', { name: 'Diagnostic report…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New canvas', exact: true }).click();
  await page.getByRole('button', { name: /^More/ }).click();
  await page.getByRole('menuitem', { name: 'Diagnostic report…' }).click();
  await expect(page.getByRole('textbox', { name: 'Diagnostic report contents' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^More/ })).toBeFocused();
});
