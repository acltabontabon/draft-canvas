/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { whatsNew } from './scripts/changelog.mjs';

/**
 * About → What's New, read out of CHANGELOG.md at build time — never a second copy of the words, and
 * never a fetch at startup. `virtual:release-highlights` is this build's releases and their marked
 * highlights, already filtered to the platform it's for: the web build carries no desktop copy and
 * the desktop build no web copy. A malformed changelog fails the build, naming the line.
 */
function releaseHighlights(platform: 'desktop' | 'web'): Plugin {
  const id = 'virtual:release-highlights';
  const changelog = fileURLToPath(new URL('./CHANGELOG.md', import.meta.url));
  return {
    name: 'draft-canvas-release-highlights',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(source) {
      if (source !== `\0${id}`) return undefined;
      this.addWatchFile(changelog);
      return `export default ${JSON.stringify(whatsNew(readFileSync(changelog, 'utf8'), platform))};`;
    },
  };
}

/**
 * The privacy promise, enforced by the browser rather than by good intentions.
 *
 * `connect-src 'self'` means no fetch, XHR, WebSocket or beacon can reach any
 * other origin — if a dependency ever tried to phone home with canvas content,
 * the browser would refuse. The one same-origin exception is the offline
 * Service Worker (Phase 6): it fetches its own precached shell assets and
 * checks for a newer build of the app itself, never anything you've drawn.
 *
 * It is injected only into the production build: the same directive would block
 * Vite's hot-reload socket during development.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'draft-canvas:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`,
        ),
    },
  };
}

/**
 * The desktop app has no Service Worker: its files ship inside the installer, and a custom-scheme
 * webview refuses to register one anyway. Rather than fork `initServiceWorker`, the desktop build
 * resolves the plugin's virtual module to one that does nothing, so no update is ever "ready".
 */
function withoutServiceWorker(): Plugin {
  const virtualId = 'virtual:pwa-register';
  return {
    name: 'draft-canvas:desktop-no-service-worker',
    resolveId: (source) => (source === virtualId ? `\0${virtualId}` : null),
    load: (id) => (id === `\0${virtualId}` ? 'export function registerSW() { return async () => {}; }' : null),
  };
}

// `base` stays relative so the built bundle can be served from any path
// (e.g. /workbench/draft-canvas/) without a rebuild.
//
/**
 * The agent's layout worker (`src/agent/worker.ts`) has no `document`. The code highlighter's entity
 * decoder (`decode-named-character-reference`, via refractor → parse-entities) ships a browser build
 * that makes an element as it loads and a worker build that doesn't — and a worker bundle is resolved
 * for the browser like the page. The worker threw as it loaded, so every agent request fell back to
 * the page's main thread and froze the editor for as long as its layout took. Worker bundles only.
 */
function workerSafeEntities(): Plugin {
  return {
    name: 'draft-canvas:worker-safe-entities',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source !== 'decode-named-character-reference') return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved ? { ...resolved, id: resolved.id.replace(/index\.dom\.js$/, 'index.js') } : null;
    },
  };
}

// `--mode desktop` builds the same app for the Tauri shell (src-tauri/): no PWA, no meta CSP (Tauri
// sets the CSP itself, and `connect-src 'self'` would block its IPC), no source maps in the
// installer, and `__DESKTOP__` true so the web build can drop the desktop code entirely.
export default defineConfig(({ mode, command }) => {
  const desktop = mode === 'desktop';
  return {
    base: './',
    // The dev server pre-bundles the highlighter once for the page and the agent's worker alike, and a
    // plugin can't reach inside that bundle — so there, both take the entity decoder's DOM-free build
    // (see `workerSafeEntities`). A production page keeps the smaller DOM one.
    ...(command === 'serve'
      ? { resolve: { alias: { 'decode-named-character-reference': fileURLToPath(new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url)) } } }
      : {}),
    define: { __DESKTOP__: JSON.stringify(desktop) },
    plugins: [
      react(),
      releaseHighlights(desktop ? 'desktop' : 'web'),
      ...(desktop
        ? [withoutServiceWorker()]
        : [
            contentSecurityPolicy(),
            // Offline app-shell caching (Phase 6). `generateSW` means Workbox builds
            // the whole Service Worker from this config — no hand-written SW source,
            // so the plugin stays a devDependency and no new runtime dependency is
            // added. `manifest: false` keeps this an offline-availability feature,
            // not an installable one (no manifest, no install prompt, no Home Screen
            // icon — that stays a deliberate non-goal). `skipWaiting`/`clientsClaim`
            // are false so a downloaded update never activates over a running
            // session — see src/lib/serviceWorker.ts for the user-triggered path.
            VitePWA({
              registerType: 'prompt',
              injectRegister: null,
              manifest: false,
              strategies: 'generateSW',
              workbox: {
                skipWaiting: false,
                clientsClaim: false,
                cleanupOutdatedCaches: true,
                navigateFallback: 'index.html',
              },
            }),
          ]),
    ],
    worker: {
      plugins: () => [workerSafeEntities()],
    },
    server: {
      // `tauri dev` needs a fixed port (5180 belongs to the web dev server and its e2e suite), and
      // the watcher must skip src-tauri/: cargo's target/ holds more files than it can watch.
      ...(desktop ? { port: 5198, strictPort: true } : { port: 5180 }),
      watch: { ignored: ['**/src-tauri/**'] },
    },
    build: {
      target: 'es2022',
      outDir: desktop ? 'dist-desktop' : 'dist',
      sourcemap: !desktop,
      rollupOptions: {
        // The desktop build has a second page: the tray panel (src-tauri/src/panel.rs). The web build
        // never ships it.
        ...(desktop
          ? {
              input: {
                main: fileURLToPath(new URL('./index.html', import.meta.url)),
                tray: fileURLToPath(new URL('./tray.html', import.meta.url)),
              },
            }
          : {}),
        output: {
          // The canvas engine and the syntax highlighter are both large and
          // rarely change; splitting them keeps the app chunk small and cacheable.
          // React gets its own chunk too: left unassigned it was folded into
          // `xyflow` (its first big importer), which then had to be preloaded by
          // the Library screen — where React Flow is never used. Its stylesheet
          // is imported up front (so app.css can override it) and must not drag
          // the JavaScript chunk along with it.
          manualChunks(id) {
            if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
            if (id.includes('node_modules/@xyflow') && !id.endsWith('.css')) return 'xyflow';
            if (id.includes('node_modules/refractor')) return 'refractor';
            return undefined;
          },
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./tests/setup.ts'],
      css: false,
      include: ['tests/**/*.test.{ts,tsx}'],
      exclude: ['e2e/**', 'node_modules/**'],
    },
  };
});
