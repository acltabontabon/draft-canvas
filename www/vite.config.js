import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { DOCS_START, docsPaths, renderDocs } from './scripts/docs.mjs';

/**
 * The version the download links point at.
 *
 * Read from the app's own package.json, which is also what src-tauri/tauri.conf.json reads
 * (`"version": "../package.json"`) and what the release tag is cut from — so a release updates this
 * page's download links by existing, with nothing here to edit. Baked in at build time rather than
 * fetched: the site makes no network requests at all (see the CSP below), and a visitor-time call to
 * the GitHub API would be one more thing that can be rate-limited, blocked, or wrong.
 */
const appVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version;

/**
 * The same promise the app makes, enforced by the browser: `connect-src 'none'` means this page
 * cannot fetch, XHR, beacon or open a socket to anywhere, including github.com.
 */
const DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
  "object-src 'none'",
];

/**
 * Any inline script on a page is allowed by hash rather than by loosening the policy. The hash is computed from the very bytes
 * that end up in the output, so it cannot drift: edit the script and the hash follows.
 */
function policyFor(html) {
  const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`,
  );
  return DIRECTIVES.map((directive) =>
    directive.startsWith('script-src') && hashes.length
      ? `${directive} ${hashes.join(' ')}`
      : directive,
  ).join('; ');
}

/**
 * `__VERSION__` in index.html becomes the release the download links point at.
 *
 * Done here rather than in JavaScript so the version, and the installer URLs built from it, are in
 * the shipped HTML: someone with scripting off still gets working downloads and an honest number.
 */
function fillLandingHtml() {
  const viewsPath = new URL('./src/checkout-views.json', import.meta.url);
  return {
    name: 'draft-canvas-www:landing-html',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => {
        const { checkout, pipeline, paymentViews, video, lakehouse, search } = JSON.parse(readFileSync(viewsPath, 'utf8'));
        return html
          .replaceAll('__VERSION__', appVersion)
          .replace('__CHECKOUT_SYSTEM__', () => checkout.system)
          .replace('__CHECKOUT_ATTACHMENTS__', () => checkout.attachments)
          .replace('__PIPELINE_SYSTEM__', () => pipeline)
          .replace('__PAYMENT_VIEWS__', () => paymentViews)
          .replace('__VIDEO_SYSTEM__', () => video)
          .replace('__LAKEHOUSE_SYSTEM__', () => lakehouse)
          .replace('__SEARCH_SYSTEM__', () => search);
      },
    },
  };
}

function contentSecurityPolicy() {
  return {
    name: 'draft-canvas-www:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policyFor(html)}" />`,
        ),
    },
  };
}

/**
 * The documentation in docs/, published as pages under docs/ (see scripts/docs.mjs).
 *
 * Rendered after the landing page is bundled, so the pages can link the very stylesheet it ended
 * up with — one stylesheet for the whole site, already cached by the time someone clicks Docs. The
 * dev server renders a page on every request instead, so an edited guide shows on a refresh.
 */
function documentation() {
  const paths = docsPaths(fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, ''));
  return {
    name: 'draft-canvas-www:docs',
    generateBundle(_, bundle) {
      const stylesheets = Object.values(bundle).filter(
        (file) => file.type === 'asset' && file.fileName.endsWith('.css'),
      );
      if (stylesheets.length !== 1) {
        this.error(`docs: expected the site to build to one stylesheet, found ${stylesheets.length}`);
      }
      const { files, media } = renderDocs({
        ...paths,
        stylesheet: stylesheets[0].fileName,
        policy: policyFor,
      });
      for (const [fileName, source] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName, source });
      }
      for (const [fileName, file] of Object.entries(media)) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(file) });
      }
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url, 'http://localhost');
        const path = decodeURIComponent(url.pathname);
        const catalog = path === '/docs-search-data.js';
        if (!catalog && path !== '/docs' && !path.startsWith('/docs/')) return next();
        if (path === '/docs' || path === '/docs/') {
          response.writeHead(302, { location: `/docs/${DOCS_START}${url.search}` }).end();
          return;
        }
        if (path === '/docs/security' || path === '/docs/security/') {
          response.writeHead(302, { location: `/docs/privacy/${url.search}` }).end();
          return;
        }
        if (path.startsWith('/docs/media/') && !path.includes('..')) {
          const file = join(paths.docsDir, path.slice('/docs/'.length));
          if (!existsSync(file)) return next();
          return createReadStream(file).pipe(response);
        }
        if (!catalog && !path.endsWith('/')) {
          response.writeHead(301, { location: `${path}/` }).end();
          return;
        }
        try {
          const { files } = renderDocs({ ...paths, stylesheet: '/src/styles.css' });
          const page = files[catalog ? path.slice(1) : `${path.slice(1)}index.html`];
          if (!page) return next();
          const type = catalog ? 'text/javascript' : 'text/html';
          response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(page);
        } catch (error) {
          // A broken link fails the build; here it should only fail the page, with the reason on it.
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(error.message));
        }
      });
    },
  };
}

// `base` stays relative so one build works wherever it is served from: at http://localhost:4174/
// while it is being written, and at https://draftcanvas.dev/ once it is deployed.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [fillLandingHtml(), contentSecurityPolicy(), documentation()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 2048,
  },
  server: { port: 5280 },
  preview: { port: 4174 },
});
