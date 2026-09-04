import { expect, test } from '@playwright/test';

/**
 * Phase 10 — Support Draft Canvas. The whole feature is one collapsed
 * disclosure inside the existing About dialog, revealing a single external
 * Ko-fi link. Nothing else in the app should reference it.
 */
test('the About dialog reveals a Ko-fi support link, opened externally', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'About Draft Canvas' }).click();
  const about = page.getByRole('dialog', { name: 'About' });
  await expect(about).toBeVisible();

  const summary = about.getByText('♥ Support Draft Canvas');
  await expect(summary).toBeVisible();

  const link = about.getByRole('link', { name: /Support Draft Canvas on Ko-fi/i });
  await expect(link).toBeHidden();

  await summary.click();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://ko-fi.com/aclt_attic');
  await expect(link).toHaveAttribute('target', '_blank');

  await page.keyboard.press('Escape');
  await expect(about).toBeHidden();
});
