import { expect, test } from '@playwright/test';

test('a diagnostic report is previewed locally and the downloaded bytes match the preview', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'About Draft Canvas' }).first().click();
  await page.getByRole('button', { name: 'Diagnostic report…' }).click();
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
  await page.getByRole('button', { name: 'Back to About' }).click();
  await expect(page.getByRole('button', { name: 'Diagnostic report…' })).toBeVisible();
});
