import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * What has to be true of the published artifact, served the way it is hosted: the site and the
 * editor each at the root of an origin of their own (draftcanvas.dev, app.draftcanvas.dev).
 * scripts/serve-web.mjs gives each a port.
 *
 * These are failures a single root-served preview cannot see: an asset URL wrong by one directory,
 * the two bundles leaking into each other. They are about
 * behaviour and structure — deliberately not about the copy on the page, which is rewritten often
 * and is not what a test should be pinning down.
 */

const port = Number(process.env.DC_WEB_PORT ?? 4174);
const SITE = '/';
const APP = `http://localhost:${port + 1}/`;

test('the landing page is served at the root, and points at the editor\'s own address', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(SITE);

  const hero = page.getByRole('region', { name: 'Make your system clear.' });
  await expect(hero.getByRole('heading', { level: 1 })).toBeInViewport();
  await expect(hero.getByRole('link', { name: /Watch it happen/ })).toBeInViewport();
  await expect(hero.getByRole('link', { name: /C4 levels/ })).toBeInViewport();
  await expect(page.getByRole('link', { name: 'Open web editor' }).first()).toHaveAttribute(
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

test('the feature overview passes the accessibility scan at desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${SITE}#features`);
  const audit = await new AxeBuilder({ page }).include('#features').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations).toEqual([]);
});

test('each thing the page names is a moment of the film, and starts the film there', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(SITE);
  const film = page.locator('#film video');
  // Nothing of the film is fetched or playing until it is wanted.
  expect(await film.evaluate((video: HTMLVideoElement) => video.paused && video.currentTime === 0)).toBe(true);
  await page.getByRole('link', { name: /^Outage: watch it in the film/ }).click();
  await expect(page).toHaveURL(SITE + '#film');
  await expect(page.locator('#film')).toBeInViewport({ ratio: 0.9 });
  await expect.poll(() => film.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThanOrEqual(68);
  await expect(page.locator('#film [aria-current="step"]')).toHaveAccessibleName(/^Outage/);
  // The room is the whole window.
  const box = (await page.locator('#film').boundingBox())!;
  expect(Math.round(box.height)).toBe(768);
});

test('the film starts by itself only when it fills the view, and never for reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(SITE);
  const film = page.locator('#film video');
  await page.locator('#film').scrollIntoViewIfNeeded();
  await page.evaluate(() => document.getElementById('film')!.scrollIntoView());
  // No press yet, so the browser may only start it silent: either way it is playing, and captioned if silent.
  await expect.poll(() => film.evaluate((video: HTMLVideoElement) => !video.paused)).toBe(true);
  const silent = await film.evaluate((video: HTMLVideoElement) => video.muted);
  if (silent) await expect(page.getByRole('button', { name: 'Turn the sound on' })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => film.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.evaluate(() => document.getElementById('film')!.scrollIntoView());
  await page.waitForTimeout(600);
  expect(await film.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
  await expect(page.getByRole('button', { name: 'Play the film' })).toBeVisible();
});

test('when the film ends, the screen points back to the ways in', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${SITE}#film`);
  const film = page.locator('#film video');
  // It starts by itself here: the room is the whole view.
  await expect.poll(() => film.evaluate((video: HTMLVideoElement) => !video.paused && video.readyState > 0)).toBe(true);
  const footerLink = page.getByRole('navigation', { name: 'Resources' }).getByRole('link', { name: 'Docs', exact: true });
  await footerLink.evaluate((link) => (link as HTMLElement).focus({ preventScroll: true }));
  await film.evaluate((video: HTMLVideoElement) => { video.currentTime = video.duration - 0.2; });
  const end = page.locator('#film .film-end');
  await expect(end).toBeVisible({ timeout: 15_000 });
  await expect(footerLink).toBeFocused();
  await expect(end.getByRole('link', { name: 'Back to top' })).toHaveAttribute('href', '#features');
  await end.getByRole('button', { name: 'Watch again' }).click();
  await expect(end).toBeHidden();
  await expect.poll(() => film.evaluate((video: HTMLVideoElement) => !video.paused && video.currentTime < 5)).toBe(true);
});

test('the film keeps the viewer’s sound choice when jumping to a chapter', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${SITE}#film`);
  const film = page.locator('#film video');
  await page.getByRole('button', { name: 'Turn the sound off' }).click();
  await page.getByRole('button', { name: 'Technology, 0:31' }).click();
  await expect.poll(() => film.evaluate((video: HTMLVideoElement) => !video.paused && video.currentTime >= 31)).toBe(true);
  await expect(page.getByRole('button', { name: 'Turn the sound on' })).toBeVisible();
  expect(await film.evaluate((video: HTMLVideoElement) => video.muted && video.textTracks[0]?.mode === 'showing')).toBe(true);
});

test.describe('the landing page with scripting disabled', () => {
  test.use({ javaScriptEnabled: false });

  test('the film has browser controls and the downloads are available inline', async ({ page }) => {
    await page.goto(SITE);
    await expect(page.locator('#film video')).toHaveAttribute('controls', '');
    await expect(page.locator('#film .film-toggle')).toBeHidden();
    await page.getByRole('link', { name: 'Download desktop app' }).first().click();
    await expect(page).toHaveURL(`${SITE}#download`);
    await expect(page.locator('#targets a')).toHaveCount(3);
    await expect(page.locator('#targets a').first()).toBeVisible();
    await expect(page.locator('#download [data-close]')).toBeHidden();
  });
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

test.describe('the documentation', () => {
  /*
   * docs/ rendered into pages by www/scripts/docs.mjs. The build already refuses a link to a page,
   * section or image it did not publish; this checks the other half — that what it published is
   * where those links say, as it is served, which a build cannot see.
   */
  const DOCS = `${SITE}docs/`;
  const START = `${DOCS}getting-started/`;

  test('every page, and everything it links to on this site, is there', async ({ page }) => {
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });

    const pages = new Set<string>([START]);
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

    expect(visited.size, 'every guide and the published references').toBeGreaterThan(10);
    for (const path of elsewhere) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
    }
    expect(failures, 'no page, stylesheet or screenshot 404s').toEqual([]);
  });

  test('is reached from the landing page, and finds its way around', async ({ page }) => {
    await page.goto(SITE);
    await page.getByRole('navigation', { name: 'Resources' }).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(page).toHaveURL(START);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Getting started');
    const sidebar = page.getByRole('navigation', { name: 'Documentation' });
    await expect(sidebar.getByRole('link', { name: 'Getting started' })).toHaveAttribute('aria-current', 'page');
    // Styled, not merely served: a stylesheet that 404'd leaves the body transparent.
    await expect(page.locator('body')).toHaveCSS('background-color', /rgb\(/);

    await expect(page.getByRole('link', { name: 'Open web editor' })).toHaveAttribute('href', 'https://app.draftcanvas.dev/');
  });

  test('redirects the old docs home and opens the current topic in the sidebar', async ({ page }) => {
    await page.goto(DOCS);
    await expect(page).toHaveURL(START);
    const sidebar = page.getByRole('navigation', { name: 'Documentation' });
    await expect(sidebar.locator('details[open]')).toHaveCount(0);
    await sidebar.getByText('Save and share', { exact: true }).click();
    await sidebar.getByRole('link', { name: 'Saving and sharing', exact: true }).click();
    await expect(sidebar.locator('details[open] > summary')).toHaveText('Save and share');
    await expect(sidebar.getByRole('link', { name: 'Saving and sharing', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(sidebar.getByRole('link', { name: 'Shapes and connectors', exact: true })).toBeHidden();
  });

  test('searches guide text locally and opens the matching section', async ({ page }) => {
    await page.goto(`${DOCS}shapes-and-connectors/`);
    await page.getByRole('button', { name: 'Search documentation' }).click();
    const search = page.getByRole('searchbox', { name: 'Search documentation' });
    const results = page.getByRole('region', { name: 'Search results' });
    await search.fill('Fulfilment worker');
    const match = results.getByRole('link', { name: /Draw Service.*Queue.*Worker/ });
    await expect(match).toBeVisible();
    await search.fill('zzznosuchdoc');
    await expect(results.getByRole('status')).toHaveText('No results. Try a different term.');
    await search.press('Escape');
    await expect(results).toBeHidden();
    await page.getByRole('button', { name: 'Search documentation' }).click();

    await search.fill('Fulfilment worker');
    await match.click();
    await expect(page).toHaveURL(/\/docs\/getting-started\/#draw-service--queue--worker$/);
  });

  test('opens search from a guide and follows a reference result on the site', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DOCS}getting-started/`);
    const trigger = page.getByRole('button', { name: 'Search documentation' });
    const dialog = page.getByRole('dialog', { name: 'Search documentation' });
    const search = dialog.getByRole('searchbox');
    await trigger.click();
    await expect(search).toBeFocused();
    await search.fill('Privacy and security');
    const reference = dialog.getByRole('link', { name: 'Privacy and security', exact: true });
    await expect(reference).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await reference.click();
    await expect(page).toHaveURL(`${DOCS}privacy/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy and security' })).toBeVisible();
  });

  test('links directly to Privacy and security with private vulnerability reporting', async ({ page }) => {
    await page.goto(START);
    const sidebar = page.getByRole('navigation', { name: 'Documentation' });
    const privacy = sidebar.getByRole('link', { name: 'Privacy and security', exact: true });
    await expect(privacy).toBeVisible();
    await privacy.click();
    await expect(page).toHaveURL(`${DOCS}privacy/`);
    await expect(page.getByRole('link', { name: 'Report a vulnerability privately' })).toHaveAttribute(
      'href', 'https://github.com/acltabontabon/draft-canvas/security/advisories/new',
    );
    await page.goto(`${DOCS}security/`);
    await expect(page).toHaveURL(`${DOCS}privacy/`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('All docs', { exact: true }).click();
    await expect(privacy).toBeVisible();
    await expect(privacy).toHaveAttribute('aria-current', 'page');
  });

  test('omits unpublished documents from navigation, search, and public routes', async ({ page }) => {
    await page.goto(START);
    const sidebar = page.getByRole('navigation', { name: 'Documentation' });
    await expect(sidebar.getByText('Contributing and maintenance')).toHaveCount(0);
    const unpublished = [
      ['changelog', 'Changelog'],
      ['contributing', 'Contributing'],
      ['releases', 'Releases'],
      ['semantics', 'Semantics'],
      ['schema', 'Document schema'],
      ['mermaid-import', 'Mermaid import'],
      ['architecture', 'Architecture'],
      ['performance', 'Performance'],
      ['agent-integration', 'Agent integration'],
      ['evolution', 'Canvas Evolution: design and security'],
    ] as const;
    for (const [, title] of unpublished) {
      await expect(sidebar.getByRole('link', { name: title, exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Search documentation' }).click();
    const search = page.getByRole('searchbox');
    const results = page.getByRole('region', { name: 'Search results' });
    for (const [slug, title] of unpublished) {
      await search.fill(title);
      await expect(results).toBeVisible();
      await expect(results.locator(`a[href*="/docs/${slug}/"]`)).toHaveCount(0);
      expect((await page.request.get(`${DOCS}${slug}/`)).status()).toBe(404);
    }
  });

  test('serves guide search under the same policy as the landing page', async ({ page }) => {
    await page.goto(`${DOCS}getting-started/`);
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      'content',
      /connect-src 'none'/,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://draftcanvas.dev/docs/getting-started/');
  });
});
