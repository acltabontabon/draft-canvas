/**
 * Specs reach into the running app through the dev server's own module URLs — `page.evaluate(() =>
 * import('/src/store/editorStore.ts'))` runs in the browser, where Vite serves that path. Typed loosely
 * on purpose: a spec reads only what it asserts on, and the app's own types stay with `src/`.
 */
declare module '/src/*' {
  // oxlint-disable-next-line typescript/no-explicit-any
  export const useEditorStore: { getState(): any; setState(partial: unknown): void };
  // oxlint-disable-next-line typescript/no-explicit-any
  export const useUiStore: { getState(): any; setState(partial: unknown): void };
}
