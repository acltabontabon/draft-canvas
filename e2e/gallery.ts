import { readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * The starters gallery as GitHub would serve it: the suite never reaches the network.
 *
 * The journeys are written against particular shapes, names and counts, so they read a gallery pinned
 * for them in `e2e/fixtures/starters/`. It is not refreshed with the public gallery: older starter
 * files must keep opening, and a redrawn starter must not rewrite forty journeys. Today's gallery is
 * held to its own check (`tests/starter-files.test.ts`, over `tests/fixtures/starters/`), and the
 * guide screenshots ask for it here with `STARTERS_SNAPSHOT=current`, to picture what people get.
 * `enabled` also records the person's choice to load starters, as "Load starters" does.
 */
const BASE = 'https://raw.githubusercontent.com/acltabontabon/draft-canvas-starters/main/';
const root = () => (process.env.STARTERS_SNAPSHOT === 'current' ? join(process.cwd(), 'tests', 'fixtures', 'starters') : join(process.cwd(), 'e2e', 'fixtures', 'starters'));

export async function serveStarterGallery(page: Page, { enabled = true }: { enabled?: boolean } = {}) {
  await page.route(`${BASE}**`, async (route) => {
    const path = normalize(new URL(route.request().url()).pathname.slice(new URL(BASE).pathname.length));
    if (path.startsWith('..')) return route.fulfill({ status: 404 });
    try {
      await route.fulfill({ body: readFileSync(join(root(), path), 'utf8'), headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain; charset=utf-8' } });
    } catch {
      await route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' } });
    }
  });
  if (enabled) await page.addInitScript(() => localStorage.setItem('draft-canvas.starters-gallery', 'on'));
}
