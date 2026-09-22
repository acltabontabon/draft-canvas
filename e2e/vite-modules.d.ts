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
  /** The whole file, with the room being edited folded back into it. */
  // oxlint-disable-next-line typescript/no-explicit-any
  export const fileOf: (state: any) => any;
  /* Enough of the document factory and operations to build a diagram a spec needs to assert on,
     rather than drawing it by hand through the UI when the drawing is not what is under test. */
  // oxlint-disable-next-line typescript/no-explicit-any
  export const createDocument: (title: string) => any;
  // oxlint-disable-next-line typescript/no-explicit-any
  export const createNode: (patch: Record<string, unknown>) => any;
  // oxlint-disable-next-line typescript/no-explicit-any
  export const createEdge: (patch: Record<string, unknown>) => any;
  // oxlint-disable-next-line typescript/no-explicit-any
  export const addNodes: (doc: any, nodes: any[]) => any;
  // oxlint-disable-next-line typescript/no-explicit-any
  export const addEdges: (doc: any, edges: any[]) => any;
  // oxlint-disable-next-line typescript/no-explicit-any
  export const renderDocumentSvg: (doc: any, options?: Record<string, unknown>) => { svg: string };
  // oxlint-disable-next-line typescript/no-explicit-any
  export const deserializeDocument: (text: string) => { document: any };
  // oxlint-disable-next-line typescript/no-explicit-any
  export const serializeDocument: (doc: any) => string;
}
