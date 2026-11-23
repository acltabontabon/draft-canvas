#!/usr/bin/env node
/*
 * Puts the web builds together into the one artifact the deploy publishes, two sites in it:
 *
 *   dist-web/site/        the marketing site and docs  ->  https://draftcanvas.dev/         (Cloudflare)
 *   dist-web/app/         the editor                   ->  https://app.draftcanvas.dev/     (Cloudflare)
 *   dist-web/cloudflare/  the Wrangler configs that deploy site/ and app/ (and the www. redirect and the
 *                         collaboration relay, relay.draftcanvas.dev)
 *
 * The editor is copied in unchanged. It builds with `base: './'` and registers its service worker
 * relatively, so where it is served is all the relocation it needs: no rebuild, no base-path flag,
 * and dist/ stays exactly what static self-hosting, the offline e2e suite and `vite preview`
 * already consume.
 *
 * Run through `npm run build:web`, which builds the editor and the site first. Assembling is kept
 * separate from building so that a failure here is obviously an assembly failure.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const editorBuild = join(root, 'dist');
const siteBuild = join(root, 'www', 'dist');
const cloudflareSource = join(root, 'www', 'cloudflare');
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

cpSync(siteBuild, join(out, 'site'), { recursive: true });
cpSync(editorBuild, join(out, 'app'), { recursive: true });
// Only the hosted editor gets these headers; dist/ itself stays free of host-specific files.
cpSync(join(cloudflareSource, 'app.headers'), join(out, 'app', '_headers'));

mkdirSync(join(out, 'cloudflare'));
// The deploy tooling's manifest and lockfile go with the configs, so the deploy installs the pinned
// Wrangler from the lockfile rather than fetching a version by name.
const deployFiles = new Set(['package.json', 'package-lock.json']);
for (const name of readdirSync(cloudflareSource)) {
  if (name.endsWith('.jsonc') || name.endsWith('.js') || deployFiles.has(name)) cpSync(join(cloudflareSource, name), join(out, 'cloudflare', name));
}

// What each site has to contain to work at all. Every one of these fails silently in production
// rather than loudly in CI.
const required = [
  ['site/index.html', 'the landing page'],
  ['site/404.html', 'the page Cloudflare serves for a missing path'],
  ['site/_redirects', 'the redirect from the old /editor/ layout to app.draftcanvas.dev'],
  ['site/docs/index.html', 'the redirect to Getting started'],
  ['site/docs/getting-started/index.html', 'the first guide, which every other page links to'],
  ['app/index.html', 'the editor entry document'],
  ['app/sw.js', "the editor's own service worker"],
  ['cloudflare/site.jsonc', 'the deploy config for draftcanvas.dev'],
  ['cloudflare/app.jsonc', 'the deploy config for app.draftcanvas.dev'],
  ['cloudflare/www.jsonc', 'the deploy config for the www. redirect'],
  ['cloudflare/relay.jsonc', 'the deploy config for relay.draftcanvas.dev'],
  ['cloudflare/relay.js', 'the collaboration relay the editor connects to'],
  ['cloudflare/relay-room.js', "the relay's rules, which relay.js imports"],
  ['cloudflare/package.json', 'the manifest that pins Wrangler for the deploy'],
  ['cloudflare/package-lock.json', 'the lockfile the deploy installs Wrangler from'],
];
for (const [path, what] of required) {
  insist(existsSync(join(out, path)), `dist-web/${path} is missing — ${what}.`);
}

// Only the editor has a service worker; one at the site's root would be one more thing to explain.
insist(!existsSync(join(out, 'site', 'sw.js')), 'a service worker reached the site root — the new site has none.');
insist(
  !readdirSync(join(out, 'site')).some((name) => name.startsWith('workbox')),
  'a Workbox artefact reached the site — the editor build leaked into it.',
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
console.log(
  `assemble-web: dist-web/ — site ${mb(bytes(join(out, 'site')))}, app ${mb(bytes(join(out, 'app')))}`,
);
console.log('assemble-web: preview both with `npm run site:preview`.');
