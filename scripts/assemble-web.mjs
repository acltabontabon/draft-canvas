#!/usr/bin/env node
/*
 * Puts the two web builds together into the one thing GitHub Pages publishes.
 *
 *   dist-web/          the marketing site  ->  https://acltabontabon.com/draft-canvas/
 *   dist-web/editor/   the app             ->  https://acltabontabon.com/draft-canvas/editor/
 *
 * The app is copied in unchanged. It builds with `base: './'` and registers its service worker
 * relatively, so being served a directory deeper is all the relocation it needs: no rebuild, no
 * base-path flag, and dist/ stays exactly what the Docker image, the offline e2e suite and
 * `vite preview` already consume.
 *
 * Run through `npm run build:web`, which builds both halves first. Assembling is kept separate from
 * building so that a failure here is obviously an assembly failure.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const editorBuild = join(root, 'dist');
const siteBuild = join(root, 'www', 'dist');
const out = join(root, 'dist-web');

function insist(condition, message) {
  if (!condition) {
    console.error(`assemble-web: ${message}`);
    process.exit(1);
  }
}

insist(existsSync(join(editorBuild, 'index.html')), 'dist/index.html is missing — run `npm run build` first.');
insist(existsSync(join(siteBuild, 'index.html')), 'www/dist/index.html is missing — run `npm run site:build` first.');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The site first, then the app underneath it. In this order an app file can never quietly land on
// top of a marketing file of the same name — and `editor/` is a directory the site does not have.
cpSync(siteBuild, out, { recursive: true });
insist(!existsSync(join(out, 'editor')), 'the marketing build already contains an editor/ entry.');
cpSync(editorBuild, join(out, 'editor'), { recursive: true });

// What the deploy has to contain to work at all. Each of these has been wrong at least once in a
// dry run, and every one of them fails silently in production rather than loudly in CI.
const required = [
  ['index.html', 'the landing page'],
  ['editor/index.html', 'the editor entry document'],
  ['editor/sw.js', "the editor's own service worker, which scopes offline use to /editor/"],
  ['sw.js', 'the retirement service worker for the old /draft-canvas/ registration'],
];
for (const [path, what] of required) {
  insist(existsSync(join(out, path)), `dist-web/${path} is missing — ${what}.`);
}

// The retirement worker and the editor's own worker are different files doing opposite jobs; if the
// copy above ever put the app's worker at the root, every visitor would be handed the old
// navigation fallback again.
insist(
  !readdirSync(out).includes('workbox-precache'),
  'a Workbox artefact reached the site root — the editor build leaked out of editor/.',
);

function bytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    total += entry.isDirectory() ? bytes(full) : statSync(full).size;
  }
  return total;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`assemble-web: dist-web/ ${mb(bytes(out))} — site ${mb(bytes(out) - bytes(join(out, 'editor')))}, editor ${mb(bytes(join(out, 'editor')))}`);
console.log('assemble-web: preview it at the real subpath with `npm run site:preview`.');
