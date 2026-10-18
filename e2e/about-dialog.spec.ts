import { expect, test } from '@playwright/test';

test('About keeps bundled licences in its credits without a donation footer', async ({ page }) => {
  await page.goto('/');
  // The loading header is replaced once storage opens; wait before giving its trigger focus.
  await expect(page.getByRole('button', { name: 'New canvas', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'About Draft Canvas' });
  // Safari mouse clicks do not focus buttons; use keyboard activation to test focus return.
  await trigger.press('Enter');
  const about = page.getByRole('dialog', { name: 'About', exact: true });
  await expect(about).toBeVisible();

  const licences = about.getByRole('link', { name: 'Licences (opens in a new tab)', exact: true });
  await expect(licences).toBeVisible();
  await expect(licences).toHaveAttribute('href', './THIRD_PARTY_LICENSES.txt');
  await expect(licences).toHaveAttribute('target', '_blank');
  await expect(licences).toHaveAttribute('rel', 'noreferrer');
  await expect(about.locator('a[href^="https://ko-fi.com/"]')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(about).toBeHidden();
  await expect(trigger).toBeFocused();
});
