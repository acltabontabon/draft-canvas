import { expect, test } from '@playwright/test';

/**
 * What has to be true of the published artifact, served the way it is hosted: the site and the
 * editor each at the root of an origin of their own (draftcanvas.dev, app.draftcanvas.dev), and the
 * old front door under /draft-canvas/ (acltabontabon.com). scripts/serve-web.mjs gives each a port.
 *
 * These are failures a single root-served preview cannot see: an asset URL wrong by one directory,
 * the two bundles leaking into each other, an old link that stopped forwarding. They are about
 * behaviour and structure — deliberately not about the copy on the page, which is rewritten often
 * and is not what a test should be pinning down.
 */

const port = Number(process.env.DC_WEB_PORT ?? 4174);
const SITE = '/';
const APP = `http://localhost:${port + 1}/`;
const OLD = `http://localhost:${port + 2}/draft-canvas/`;

test('the landing page is served at the root, and points at the editor\'s own address', async ({ page }) => {
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
    'https://app.draftcanvas.dev/',
  );
  expect(failures, 'nothing on the landing page 404s').toEqual([]);
  expect(errors).toEqual([]);
});

test('the editor is served at the root of its own origin, and survives a refresh', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(APP);
  await expect(page.locator('#root')).not.toBeEmpty();

  await page.reload();
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(failures, 'every chunk, style and asset resolves').toEqual([]);
});

test("the editor registers its own service worker; the site registers none", async ({ page }) => {
  await page.goto(APP);
  // A poll over `page.evaluate`, not `waitForFunction`: the latter does not await an async predicate.
  const scopesNow = () =>
    page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((registration) => registration.scope));
  await expect.poll(async () => (await scopesNow()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  for (const scope of await scopesNow()) expect(scope).toBe(APP);

  await page.goto(SITE);
  expect(await scopesNow(), 'the landing page has no worker of its own').toEqual([]);
});

test('an ordinary anchor stays on the landing page', async ({ page }) => {
  await page.goto(`${SITE}#features`);
  await expect(page).toHaveURL(/\/#features$/);
  await expect(page.locator('#features')).toBeVisible();
});

test('the two bundles stay apart', async ({ page }) => {
  await page.goto(SITE);
  const siteAssets = await page.evaluate(() =>
    [...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map(
      (node) => node.getAttribute('src') ?? node.getAttribute('href') ?? '',
    ),
  );
  expect(siteAssets.every((url) => url.startsWith('./') || url.startsWith('/'))).toBe(true);

  await page.goto(APP);
  const editorAssets = await page.evaluate(() =>
    [...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map(
      (node) => node.getAttribute('src') ?? node.getAttribute('href') ?? '',
    ),
  );
  // Every asset from the editor's own origin, none of them climbing out of its own build. Written
  // relative in the page; a lazy chunk's stylesheet is added later by Vite's preload, resolved
  // against the chunk's own address, so it arrives absolute but on the same origin.
  for (const url of editorAssets) {
    expect(url.startsWith('..'), `${url} reaches out of the editor`).toBe(false);
    const resolved = new URL(url, APP);
    expect(resolved.origin, `${url} loads from another origin`).toBe(new URL(APP).origin);
    expect(resolved.pathname.startsWith(new URL(APP).pathname), `${url} reaches out of the editor`).toBe(true);
  }
});

test('a path the site does not have gets its 404 page', async ({ page }) => {
  const response = await page.goto('/no-such-page/');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('link', { name: 'Open the editor' })).toHaveAttribute('href', 'https://app.draftcanvas.dev/');
});

test('the editor asks not to be indexed as a second landing page', async ({ page }) => {
  await page.goto(APP);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  // Off a release tag the editor here is the latest release, which can predate a change of
  // address, so this asks only that it never claims the landing page's place. The exact address
  // is pinned against the current source in tests/site-isolation.test.ts.
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(canonical).toMatch(/^https:\/\//);
  expect(canonical).not.toBe('https://draftcanvas.dev/');

  await page.goto(SITE);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://draftcanvas.dev/');
});

test.describe('the old address', () => {
  test('says where Draft Canvas moved, styled and without errors', async ({ page }) => {
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(OLD);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', /rgb\(/);
    await expect(page.getByRole('link', { name: 'Go to draftcanvas.dev' })).toHaveAttribute('href', 'https://draftcanvas.dev/');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://draftcanvas.dev/');
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('redirects a directory without its trailing slash rather than breaking', async ({ page }) => {
    /*
     * With a relative `base`, a page served at /draft-canvas would resolve ./assets/* against the
     * origin root and load nothing at all. GitHub Pages redirects to the trailing-slash form instead
     * — verified against the sibling project site, https://acltabontabon.com/scuttle — and
     * scripts/serve-web.mjs reproduces that here so the preview cannot be more forgiving than
     * production.
     */
    const response = await page.goto(OLD.replace(/\/$/, ''));
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(OLD);
    await expect(page.locator('h1')).toBeVisible();
  });

  test('keeps the editor, so diagrams saved there can be brought along', async ({ page }) => {
    await page.goto(`${OLD}editor/`);
    await expect(page.locator('#root')).not.toBeEmpty();
  });

  test('puts their diagrams first for someone who has drawn here', async ({ page }) => {
    // The key the app writes the first time it runs. Nothing is opened and no diagram is read.
    await page.addInitScript(() => localStorage.setItem('draft-canvas.personality', 'plain'));
    await page.goto(OLD);
    await expect(page.locator('#yours')).toHaveAttribute('data-found', '');
    await expect(page.locator('#yours a[href="./editor/"]')).toBeVisible();
  });

  test('forwards every other old link to the same page on draftcanvas.dev', async ({ page }) => {
    // Stop at the forward rather than leaving the machine: the target is the real domain.
    await page.route('https://draftcanvas.dev/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>new home</h1>' }),
    );
    await page.goto(`${OLD}docs/getting-started/?from=old#install`);
    // The fragment never reaches a server, so it is the address bar that has to carry it across.
    await expect(page).toHaveURL('https://draftcanvas.dev/docs/getting-started/?from=old#install');
  });
});

test.describe('the documentation', () => {
  /*
   * docs/ rendered into pages by www/scripts/docs.mjs. The build already refuses a link to a page,
   * section or image it did not publish; this checks the other half — that what it published is
   * where those links say, as it is served, which a build cannot see.
   */
  const DOCS = `${SITE}docs/`;

  test('every page, and everything it links to on this site, is there', async ({ page }) => {
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });

    const pages = new Set<string>([DOCS]);
    const visited = new Set<string>();
    const elsewhere = new Set<string>();
    while (visited.size < pages.size) {
      const next = [...pages].find((path) => !visited.has(path))!;
      visited.add(next);
      await page.goto(next);
      await expect(page.locator('h1')).toBeVisible();
      const targets = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement | HTMLImageElement>('a[href], img[src]')]
          .map((node) => ('href' in node ? node.href : node.src))
          .filter((url) => new URL(url).origin === location.origin),
      );
      for (const target of targets) {
        const { pathname } = new URL(target);
        if (pathname.startsWith(DOCS) && pathname.endsWith('/')) pages.add(pathname);
        else elsewhere.add(pathname);
      }
    }

    expect(visited.size, 'the index, every guide and the published reference').toBeGreaterThan(10);
    for (const path of elsewhere) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
    }
    expect(failures, 'no page, stylesheet or screenshot 404s').toEqual([]);
  });

  test('is reached from the landing page, and finds its way around', async ({ page }) => {
    await page.goto(SITE);
    await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(page).toHaveURL(/\/docs\/$/);

    const sidebar = page.getByRole('navigation', { name: 'Documentation' }).first();
    await sidebar.getByRole('link', { name: 'Getting started' }).click();
    await expect(page).toHaveURL(/\/docs\/getting-started\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Getting started');
    await expect(sidebar.getByRole('link', { name: 'Getting started' })).toHaveAttribute('aria-current', 'page');
    // Styled, not merely served: a stylesheet that 404'd leaves the body transparent.
    await expect(page.locator('body')).toHaveCSS('background-color', /rgb\(/);

    await expect(page.getByRole('link', { name: 'Open editor' })).toHaveAttribute('href', 'https://app.draftcanvas.dev/');
  });

  test('runs no script, under the same policy as the landing page', async ({ page }) => {
    await page.goto(`${DOCS}getting-started/`);
    expect(await page.locator('script').count()).toBe(0);
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      'content',
      /connect-src 'none'/,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://draftcanvas.dev/docs/getting-started/');
  });
});
