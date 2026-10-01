import { chromium, firefox, webkit, type FullConfig } from '@playwright/test';

/**
 * Warms a freshly started dev server before the first test runs. Vite compiles each chunk the first
 * time a browser asks for it, and the editor is a lazy chunk behind the Library: the first test to
 * press "New canvas" on a cold server waited longer for `.dc-editor` than its own expectation
 * allowed, and failed the run for nothing. One real page load here pays that cost once, outside
 * any test's clock. A server that is already warm (reused, or a built site) costs a second.
 */
export default async function warm(config: FullConfig): Promise<void> {
  const project = config.projects[0];
  const baseURL = project?.use.baseURL;
  if (!baseURL) return;
  // The engine this run uses — a CI shard installs only its own browser.
  const engines = { chromium, firefox, webkit };
  const browser = await engines[project?.use.defaultBrowserType ?? 'chromium'].launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseURL, { waitUntil: 'load', timeout: 120_000 });
    const newCanvas = page.getByRole('button', { name: 'New canvas' }).first();
    if (await newCanvas.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await newCanvas.click();
      await page.locator('.dc-editor').waitFor({ state: 'visible', timeout: 120_000 }).catch(() => undefined);
    }
  } finally {
    await browser.close();
  }
}
