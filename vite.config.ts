/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
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
 * The version this build is: package.json's, unless desktop-release.yml is building a desktop preview
 * ahead of it (`desktop-v1.12.0-beta.1`), when it has written the tag's version to
 * `src-tauri/tauri.version.conf.json` for Tauri first. Reading the same file keeps About and What's New
 * on the version the installer carries, instead of naming the last release.
 */
function appVersion(desktop: boolean): string {
  const read = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as { version?: string };
  const released = read('./package.json').version as string;
  if (!desktop) return released;
  try {
    return read('./src-tauri/tauri.version.conf.json').version ?? released;
  } catch {
    return released;
  }
}

/**
 * Where live collaboration's relay is (`__COLLAB_RELAY__`): the WebSocket address an owner and the
 * people joining them use to trade a few end-to-end-encrypted messages — a knock, then the WebRTC
 * offer and answer — before they connect directly. `VITE_COLLAB_RELAY` overrides it, from the
 * environment or a `.env` file; set it to nothing for a build with no relay, where invites fall back
 * to copying reply codes by hand. Unset, a production build uses relay.draftcanvas.dev and the dev
 * server the local one, `node scripts/dev-relay.mjs` (port 8791).
 *
 * A path is allowed (a relay behind a reverse proxy); the app appends `/r/<room>` to it.
 */
function collabRelay(mode: string, command: 'serve' | 'build'): string {
  const configured = loadEnv(mode, process.cwd(), 'VITE_COLLAB_RELAY').VITE_COLLAB_RELAY;
  const relay = (configured ?? (command === 'serve' ? 'ws://localhost:8791' : 'wss://relay.draftcanvas.dev')).trim();
  if (relay === '') return '';
  let url: URL;
  try {
    url = new URL(relay);
  } catch {
    throw new Error(`VITE_COLLAB_RELAY must be a ws:// or wss:// URL, not "${relay}".`);
  }
  if ((url.protocol !== 'wss:' && url.protocol !== 'ws:') || url.search || url.hash || url.username || url.password) {
    throw new Error(`VITE_COLLAB_RELAY must be a ws:// or wss:// URL with no query, fragment or credentials, not "${relay}".`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The privacy promise, enforced by the browser rather than by good intentions.
 *
 * `connect-src` names `'self'` and the collaboration relay, and nothing else: no fetch, XHR,
 * WebSocket or beacon can reach any other origin — if a dependency ever tried to phone home with
 * canvas content, the browser would refuse. The relay only ever carries messages the two browsers
 * have already encrypted with a key it never sees. The one same-origin exception is the offline
 * Service Worker (Phase 6): it fetches its own precached shell assets and checks for a newer build
 * of the app itself, never anything you've drawn.
 *
 * It is injected only into the production build: the same directive would block
 * Vite's hot-reload socket during development.
 */
const contentSecurityPolicyFor = (relay: string) => [
  "default-src 'self'",
  "script-src 'self'",
  // 'unsafe-inline' for styles stays: React Flow positions nodes, edges and its viewport through
  // `style` attributes it writes into the DOM (`transform: translate(…)` on every element), and so
  // do our own display-list SVGs (`fill`, `stroke-dasharray` as presentation attributes are fine,
  // but the inline `style` on the canvas layers is not). A nonce can't cover attributes, and a hash
  // per element is impossible for values that change every frame. Script stays strict.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  relay ? `connect-src 'self' ${new URL(relay).origin}` : "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Ships THIRD_PARTY_LICENSES.txt beside the app (web, Pages and the desktop bundle all take
 * the build output as it is), so the notices the shipped packages require travel with the code.
 * Package licences are generated by `npm run licenses` and checked for staleness in CI. Prepend
 * the human-maintained asset credits too, so About's Licences link includes the bundled logos.
 */
function thirdPartyLicenses(): Plugin {
  return {
    name: 'draft-canvas:third-party-licenses',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: ['NOTICE', 'src/nodes/technologyCatalog/NOTICE.txt', 'THIRD_PARTY_LICENSES.txt']
          .map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'))
          .join('\n\n'),
      });
    },
  };
}

function contentSecurityPolicy(relay: string): Plugin {
  return {
    name: 'draft-canvas:csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicyFor(relay)}" />`,
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
  const relay = collabRelay(mode, command);
  return {
    base: './',
    // The dev server pre-bundles the highlighter once for the page and the agent's worker alike, and a
    // plugin can't reach inside that bundle — so there, both take the entity decoder's DOM-free build
    // (see `workerSafeEntities`). A production page keeps the smaller DOM one.
    ...(command === 'serve'
      ? { resolve: { alias: { 'decode-named-character-reference': fileURLToPath(new URL('./node_modules/decode-named-character-reference/index.js', import.meta.url)) } } }
      : {}),
    define: {
      __DESKTOP__: JSON.stringify(desktop),
      __APP_VERSION__: JSON.stringify(appVersion(desktop)),
      __COLLAB_RELAY__: JSON.stringify(relay),
    },
    plugins: [
      react(),
      thirdPartyLicenses(),
      releaseHighlights(desktop ? 'desktop' : 'web'),
      ...(desktop
        ? [withoutServiceWorker()]
        : [
            contentSecurityPolicy(relay),
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
                // No SPA fallback: the app has one page and no routes, and static hosts should return 404 for
                // unknown paths for the same reason — index.html served at /a/b would ask for
                // /a/assets/*.js. Offline, `/` is still answered from the precache (Workbox maps a
                // directory request to its index.html); anything else is as unknown offline as on.
                navigateFallback: null,
                // Workbox's default takes only js, css and html, so About → Licences failed offline.
                // Named rather than `*.txt`: it is ~1.1 MB (~150 kB compressed), and nothing else
                // plain-text should start riding along in every install unnoticed.
                globPatterns: ['**/*.{js,css,html}', 'THIRD_PARTY_LICENSES.txt'],
              },
            }),
          ]),
    ],
    worker: {
      plugins: () => [workerSafeEntities()],
    },
    // Dev only. By default Vite scans index.html's static imports for dependencies to pre-bundle, so a
    // dependency first reached through a lazily loaded module (the editor, a dialog, the desktop
    // screens) was discovered mid-session: Vite re-bundled, and the import already in flight failed
    // ("Importing a module script failed" in WebKit). Scanning every source file finds them all at
    // start-up instead.
    optimizeDeps: {
      entries: ['index.html', 'src/**/*.{ts,tsx}', '!src/**/*.d.ts'],
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
      // Coverage instruments every line, and the agent gallery composes and lays out whole diagrams:
      // on a two-core CI runner that took those tests past the 5 s default. Only the instrumented
      // run gets the headroom — a plain `npm test` keeps the tight limit that catches a slow path.
      ...(process.argv.includes('--coverage') ? { testTimeout: 30_000 } : {}),
      // `npm run test:coverage`. The floor sits just under what the suite reached when it was set
      // (1.12: 71 / 62 / 66 / 74), so coverage can only go up without someone deciding otherwise.
      coverage: {
        provider: 'v8',
        include: ['src/**'],
        // Vite turns JSON assets into executable exports. Count the loader logic, not generated
        // logo coordinates; catalog freshness and every dynamic path group are tested separately.
        exclude: ['src/nodes/technologyCatalog/*.json'],
        reporter: ['text-summary', 'html'],
        thresholds: { statements: 70, branches: 60, functions: 64, lines: 72 },
      },
    },
  };
});
