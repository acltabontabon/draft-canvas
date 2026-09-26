import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

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
 *
 * Deliberately absent: `frame-ancestors`. Copies of the retired Draft Canvas for VS Code up to 0.1.6
 * load `/draft-canvas/?host=vscode` inside a webview frame, and the inline script in index.html
 * forwards it to the editor's retirement notice. A `frame-ancestors` directive here would break that
 * frame before the script ever ran.
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
 * The one inline script on the page is the legacy editor-link router, and it has to run before the
 * document paints. Rather than loosen the policy for it, the hash is computed from the very bytes
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
function versionInHtml() {
  return {
    name: 'draft-canvas-www:version',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll('__VERSION__', appVersion),
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

// `base` stays relative so one build works wherever it is served from: at http://localhost:4174/
// while it is being written, and at https://acltabontabon.com/draft-canvas/ once GitHub Pages has
// it. The apex belongs to the acltabontabon.github.io repository and cascades to every project
// site, so the /draft-canvas/ prefix comes from the repository name and is never written down here.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [versionInHtml(), contentSecurityPolicy()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 2048,
  },
  server: { port: 5280 },
  preview: { port: 4174 },
});
