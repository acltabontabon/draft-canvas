import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * The starters gallery as GitHub would serve it, from the vendored snapshot in
 * `tests/fixtures/starters/` (`npm run starters:fixtures`): the suite never reaches the network.
 * `enabled` also records the person's choice to load starters, as "Load starters" does.
 */
const BASE = 'https://raw.githubusercontent.com/acltabontabon/draft-canvas-starters/main/';
const ROOT = join(process.cwd(), 'tests', 'fixtures', 'starters');

export async function serveStarterGallery(page: Page, { enabled = true }: { enabled?: boolean } = {}) {
  await page.route(`${BASE}**`, async (route) => {
    const path = normalize(new URL(route.request().url()).pathname.slice(new URL(BASE).pathname.length));
    if (path.startsWith('..')) return route.fulfill({ status: 404 });
    try {
      await route.fulfill({ body: readFileSync(join(ROOT, path), 'utf8'), headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain; charset=utf-8' } });
    } catch {
      await route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
    }
  });
  if (enabled) await page.addInitScript(() => localStorage.setItem('draft-canvas.starters-gallery', 'on'));
}
