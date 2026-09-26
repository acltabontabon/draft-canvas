import { expect, test } from '@playwright/test';

/**
 * What has to be true of the published artifact, at the path it is actually published under.
 *
 * These are all failures that a root-served preview cannot see: an asset URL wrong by one
 * directory, a service worker whose scope swallows the landing page, a released VS Code extension
 * whose frame stops reaching the editor, or the marketing stylesheet turning up in the app. They
 * are about behaviour and structure — deliberately not about the copy on the page, which is
 * rewritten often and is not what a test should be pinning down.
 */

const SITE = '/draft-canvas/';
const EDITOR = '/draft-canvas/editor/';

test('the landing page is served at the project root', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(SITE);

  await expect(page.locator('h1')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open live editor' }).first()).toHaveAttribute(
    'href',
    './editor/',
  );
  expect(failures, 'nothing 404s under the subpath').toEqual([]);
  expect(errors).toEqual([]);
});

test('the editor is served one level down, and survives a refresh there', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(EDITOR);
  await expect(page.locator('#root')).not.toBeEmpty();

  await page.reload();
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(failures, 'every chunk, style and asset resolves under /editor/').toEqual([]);
});

test("the editor's service worker is scoped to the editor, and never to the landing page", async ({
  page,
}) => {
  await page.goto(EDITOR);
  const handle = await page.waitForFunction(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.length ? registrations.map((registration) => registration.scope) : null;
  });
  const scopes = (await handle.jsonValue()) ?? [];

  expect(scopes.length, 'the editor registers a worker of its own').toBeGreaterThan(0);
  for (const scope of scopes) {
    expect(scope, 'a scope covering /draft-canvas/ would serve the app at the landing page').toContain(
      '/draft-canvas/editor/',
    );
  }
});

test('a retired VS Code extension still reaches a page that says so', async ({ page }) => {
  // Every published extension up to 0.1.6 loads this exact URL into its webview frame; the landing
  // page forwards it to the editor, which shows the retirement notice rather than the Library.
  await page.goto(`${SITE}?host=vscode`);
  await expect(page).toHaveURL(/\/draft-canvas\/editor\/\?host=vscode$/);
  await expect(page.getByRole('heading', { name: /has been retired/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download the desktop app' })).toBeVisible();
});

test('an ordinary anchor stays on the landing page', async ({ page }) => {
  await page.goto(`${SITE}#export`);
  await expect(page).toHaveURL(/\/draft-canvas\/#export$/);
  await expect(page.locator('#export')).toBeVisible();
});

test('the two bundles stay apart', async ({ page }) => {
  const siteAssets = await page.goto(SITE).then(() =>
    page.evaluate(() => [
      ...[...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map(
        (node) => node.getAttribute('src') ?? node.getAttribute('href') ?? '',
      ),
    ]),
  );
  expect(siteAssets.some((url) => url.includes('editor/'))).toBe(false);

  await page.goto(EDITOR);
  const editorAssets = await page.evaluate(() =>
    [...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map(
      (node) => node.getAttribute('src') ?? node.getAttribute('href') ?? '',
    ),
  );
  // Relative URLs only, and none of them climbing back out to the site's own bundle.
  for (const url of editorAssets) {
    expect(url.startsWith('..'), `${url} reaches out of the editor`).toBe(false);
  }
  expect(await page.locator('link[href*="../assets"]').count()).toBe(0);
});

test('a directory URL without its trailing slash redirects rather than breaking', async ({ page }) => {
  /*
   * With a relative `base`, a page served at /draft-canvas would resolve ./assets/* against the
   * origin root and load nothing at all. GitHub Pages redirects to the trailing-slash form instead
   * — verified against the sibling project site, https://acltabontabon.com/scuttle — and
   * scripts/serve-web.mjs reproduces that here so the preview cannot be more forgiving than
   * production. This pins that down: if the preview ever stops redirecting, so does the thing this
   * suite is checking.
   */
  const response = await page.goto('/draft-canvas');
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/draft-canvas\/$/);
  // Loaded, not merely reachable: a stylesheet that 404'd leaves the body transparent.
  await expect(page.locator('body')).toHaveCSS('background-color', /rgb\(/);
  await expect(page.locator('h1')).toBeVisible();
});

test.describe('the notice about the editor moving', () => {
  /*
   * It is addressed to someone who came here for the editor, so it has to be invisible to everyone
   * else. It was not, once: the panel sets `display: flex`, and author CSS beats the `hidden`
   * attribute's `display: none`, so the first build showed it to every first-time visitor.
   */
  test('stays out of the way of a first visit', async ({ page }) => {
    await page.goto(SITE);
    await expect(page.locator('#moved')).toBeHidden();
    await expect(page.locator('#hero-cta-label')).toHaveText('Open live editor');
  });

  test('appears for someone who has drawn here before', async ({ page }) => {
    // The key the app writes the first time it runs. Nothing is opened and no diagram is read.
    await page.addInitScript(() => localStorage.setItem('draft-canvas.personality', 'plain'));
    await page.goto(SITE);
    await expect(page.locator('#moved')).toBeVisible();
    await expect(page.locator('#hero-cta-label')).toHaveText('Open your diagrams');
    await expect(page.locator('#moved a[href="./editor/"]')).toBeVisible();

    await page.locator('#moved-dismiss').click();
    await expect(page.locator('#moved')).toBeHidden();
    await page.reload();
    await expect(page.locator('#moved')).toBeHidden();
    // Dismissing the notice must not take away the way back to their own work.
    await expect(page.locator('#hero-cta-label')).toHaveText('Open your diagrams');
  });
});

test('the editor asks not to be indexed as a second landing page', async ({ page }) => {
  await page.goto(EDITOR);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/draft-canvas\/editor\/$/);

  await page.goto(SITE);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/draft-canvas\/$/);
});
