/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** True in the Tauri desktop build (`vite --mode desktop`), and only there: the web build drops the desktop code. */
declare const __DESKTOP__: boolean;

/** The version this build is: package.json's, or a desktop preview's own (see `appVersion` in vite.config.ts). */
declare const __APP_VERSION__: string;

/**
 * Live collaboration's relay: a ws:// or wss:// base URL with no trailing slash
 * (`wss://relay.draftcanvas.dev`, or `ws://localhost:8791` under `npm run dev`), or `''` in a build
 * without one. See `collabRelay` in vite.config.ts.
 */
declare const __COLLAB_RELAY__: string;

/** This build's What's New, read out of CHANGELOG.md by vite.config.ts — see `releaseHighlights` there. */
declare module 'virtual:release-highlights' {
  const releases: import('./releases/types').ProductRelease[];
  export default releases;
}
