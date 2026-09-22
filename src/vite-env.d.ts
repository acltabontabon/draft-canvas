/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** True in the Tauri desktop build (`vite --mode desktop`), and only there: the web build drops the desktop code. */
declare const __DESKTOP__: boolean;
