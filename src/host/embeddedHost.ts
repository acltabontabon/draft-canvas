/**
 * Set when a host editor frames the app for a single `.draftcanvas` file. Today that host is only
 * the VS Code extension (`vscode-extension/`), which loads the app at `?host=vscode`.
 *
 * In that mode the file is where the document lives, not this browser. The host owns opening,
 * saving and the tab's lifetime, so there is no Library, and IndexedDB is never opened.
 */
export const embeddedHost: 'vscode' | null = detectHost();

function detectHost(): 'vscode' | null {
  try {
    const framed = window.parent !== window;
    return framed && new URLSearchParams(window.location.search).get('host') === 'vscode' ? 'vscode' : null;
  } catch {
    return null;
  }
}

/**
 * Messages between the app and its host. The app's protocol version travels with `ready`, so a host
 * can tell an app that predates a message it relies on.
 */
export const HOST_PROTOCOL = 3;

export type ToHostMessage =
  | { type: 'draft-canvas:ready'; protocol: number }
  /** `baseSeq` since protocol 3: the `seq` of the load this edit was made on top of. */
  | { type: 'draft-canvas:change'; text: string; baseSeq?: number }
  | { type: 'draft-canvas:save'; saveAs: boolean }
  /** Since protocol 2. A link the frame can't open itself: the host's webview allows no popups. */
  | { type: 'draft-canvas:open-external'; url: string };

export interface LoadMessage {
  type: 'draft-canvas:load';
  /** The file's contents. Empty means a new file, which gets a fresh document. */
  text: string;
  /** The file's name without its extension, used as the title of a new document. */
  title?: string;
  /**
   * Since protocol 3: counts up with every load the host sends. A change carries back the `seq` it
   * was made on (`baseSeq`), so when the file was replaced from outside (a revert, a checkout) while
   * an edit was on its way, the host can drop that edit instead of writing the old contents over the
   * new ones. Absent from an older host, and then nothing is dropped.
   */
  seq?: number;
}

/** A VS Code webview's origin. Anything else framing the app at `?host=vscode` is not its host. */
export function isHostOrigin(origin: string): boolean {
  return origin.startsWith('vscode-webview://');
}
