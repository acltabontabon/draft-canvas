import { expect, test } from '@playwright/test';

/**
 * Phase 10 — Support Draft Canvas. A single human footnote inside the
 * existing About dialog: one external Ko-fi link, visible immediately.
 * Nothing else in the app should reference it.
 */
test('the About dialog shows a Ko-fi support link, opened externally', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'About Draft Canvas' }).click();
  const about = page.getByRole('dialog', { name: 'About' });
  await expect(about).toBeVisible();

  const link = about.getByRole('link', { name: /Buy the builder a coffee/i });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://ko-fi.com/aclt_attic');
  await expect(link).toHaveAttribute('target', '_blank');

  await page.keyboard.press('Escape');
  await expect(about).toBeHidden();
});
