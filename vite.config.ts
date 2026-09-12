/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

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

// `base` stays relative so the built bundle can be served from any path
// (e.g. /workbench/draft-canvas/) without a rebuild.
export default defineConfig({
  base: './',
  plugins: [
    react(),
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
  ],
  server: { port: 5180 },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
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
});
