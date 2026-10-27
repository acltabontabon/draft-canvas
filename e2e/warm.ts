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
    // The brand also renders while storage opens. Wait for the actual home screen so its
    // replacement cannot swallow the About click on a cold CI startup.
    const newCanvas = page.getByRole('button', { name: 'New canvas' }).first();
    await newCanvas.waitFor({ state: 'visible', timeout: 120_000 });
    // About is a lazy chunk too, carrying every release's notes, and the first test to open it on a
    // cold server (Firefox in CI) waited past its own expectation for the dialog.
    const about = page.getByRole('button', { name: 'About Draft Canvas' }).first();
    // `isVisible` returns immediately even with a timeout: on a cold render it skipped the
    // warm-up altogether. Wait for each surface and let a broken setup fail here, before tests.
    await about.waitFor({ state: 'visible', timeout: 120_000 });
    await about.click();
    const dialog = page.getByRole('dialog', { name: 'About' });
    await dialog.waitFor({ state: 'visible', timeout: 120_000 });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
    await newCanvas.click();
    await page.locator('.dc-editor').waitFor({ state: 'visible', timeout: 120_000 });
  } finally {
    await browser.close();
  }
}
