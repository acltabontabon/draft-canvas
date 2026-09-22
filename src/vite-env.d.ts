/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** True in the Tauri desktop build (`vite --mode desktop`), and only there: the web build drops the desktop code. */
declare const __DESKTOP__: boolean;

/** This build's What's New, read out of CHANGELOG.md by vite.config.ts — see `releaseHighlights` there. */
declare module 'virtual:release-highlights' {
  const releases: import('./releases/types').ProductRelease[];
  export default releases;
}
