/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The privacy promise, enforced by the browser rather than by good intentions.
 *
 * `connect-src 'none'` means no fetch, XHR, WebSocket or beacon can leave the
 * page at all — if a dependency ever tried to phone home with canvas content,
 * the browser would refuse. It costs nothing, because there is no backend to
 * talk to.
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
  "connect-src 'none'",
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
  plugins: [react(), contentSecurityPolicy()],
  server: { port: 5180 },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // The canvas engine and the syntax highlighter are both large and
        // rarely change; splitting them keeps the app chunk small and cacheable.
        manualChunks(id) {
          if (id.includes('node_modules/@xyflow')) return 'xyflow';
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
