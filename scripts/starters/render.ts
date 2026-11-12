/**
 * Renders the pictures of a starters gallery checkout (github.com/acltabontabon/draft-canvas-starters):
 * each `<id>.draftcanvas` gets a `preview.svg` and `preview-dark.svg` beside it, drawn by the app's own
 * Use-in-docs renderer in a real browser, so text is measured with real fonts.
 *
 *   npx tsx scripts/starters/render.ts --repo ../draft-canvas-starters
 *
 * Runs its own dev server on a port of its own (never 5180, which the e2e suite shares) and stops
 * exactly the process group it started.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { startServer, SERVER_URL as URL } from './server';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function starterFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.draftcanvas')) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

/** One file's two pictures, rendered in the page from the app's own modules. */
async function renderPreviews(page: Page, text: string, source: string): Promise<{ light: string; dark: string }> {
  return page.evaluate(
    async ({ text, source }) => {
      const project = await import('/src/export/project.ts');
      const docs = await import('/src/export/docs/image.ts');
      const parsed = project.deserializeDocument(text);
      if (!parsed.ok) throw new Error(`${source}: ${parsed.error}`);
      const render = async (theme: 'light' | 'dark') => {
        const result = await docs.renderDocsImage(parsed.document, source, { view: [], theme, style: 'clean', sync: true });
        if (!result.ok) throw new Error(`${source}: ${result.reason}`);
        return result.svg;
      };
      return { light: await render('light'), dark: await render('dark') };
    },
    { text, source },
  );
}

async function main() {
  const repo = flag('repo');
  if (!repo) throw new Error('Usage: npx tsx scripts/starters/render.ts --repo <starters checkout>');
  const files = starterFiles(resolve(repo, 'starters'));
  if (files.length === 0) throw new Error(`No .draftcanvas files under ${resolve(repo, 'starters')}.`);
  const stop = await startServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // tsx keeps function names with an `__name` helper the page doesn't have.
    await page.addInitScript({ content: 'globalThis.__name = (f) => f;' });
    await page.goto(URL);
    for (const file of files) {
      const { light, dark } = await renderPreviews(page, readFileSync(file, 'utf8'), basename(file));
      writeFileSync(join(dirname(file), 'preview.svg'), `${light}\n`);
      writeFileSync(join(dirname(file), 'preview-dark.svg'), `${dark}\n`);
      console.log(`rendered ${file}`);
    }
  } finally {
    await browser.close();
    await stop();
  }
}

await main();
