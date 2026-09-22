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
export const HOST_PROTOCOL = 6;

export type ToHostMessage =
  | { type: 'draft-canvas:ready'; protocol: number }
  /** `baseSeq` since protocol 3: the `seq` of the load this edit was made on top of. */
  | { type: 'draft-canvas:change'; text: string; baseSeq?: number }
  | { type: 'draft-canvas:save'; saveAs: boolean }
  /** Since protocol 2. A link the frame can't open itself: the host's webview allows no popups. */
  | { type: 'draft-canvas:open-external'; url: string }
  /**
   * Since protocol 4, and only to a host whose load said `clipboard`: copied shapes for the system clipboard.
   * `plain` since protocol 5, and only to a host whose load said `textEditing`: text copied out of a field.
   */
  | { type: 'draft-canvas:clipboard-write'; text: string; plain?: boolean }
  /**
   * Since protocol 4, likewise: asks for the system clipboard, answered by a `ClipboardMessage` with this `id`.
   * `plain` (protocol 5, `textEditing` hosts only) asks for whatever text it holds, to paste into a field.
   */
  | { type: 'draft-canvas:clipboard-read'; id: number; plain?: boolean }
  /**
   * Since protocol 5: a chord from the `keys` the host's load listed, pressed in the frame and not used by
   * the app, so the host can run its own command for it. Named like `cmd+shift+p` (see `chordOf`).
   */
  | { type: 'draft-canvas:key'; chord: string }
  /**
   * Since protocol 6, and only to a host whose load said `background`: the canvas's background image
   * as it stands now (base64), for the host to keep beside the file. It says so again on every change.
   */
  | { type: 'draft-canvas:background-write'; mime: string; data: string }
  /** Since protocol 6, likewise: the canvas no longer has a background image. */
  | { type: 'draft-canvas:background-remove' }
  /** Since protocol 6, likewise: asks for the file's stored image, answered by a `BackgroundMessage` with this `id`. */
  | { type: 'draft-canvas:background-read'; id: number }
  /**
   * The next two are only ever sent to the desktop shell, which lives in the same page: they never
   * cross VS Code's bridge, whose allow-list would drop them. The open document was closed — Home is showing.
   */
  | { type: 'draft-canvas:closed' }
  /** The answer to a `flush` command, once the app has posted every edit still pending. */
  | { type: 'draft-canvas:flushed'; id: number };

/**
 * Desktop shell to app. `flush` has the app let go of a field still being typed in and post what is
 * pending, so the shell acts on exactly what is on screen; `close` leaves the open document for Home.
 */
export interface CommandMessage {
  type: 'draft-canvas:command';
  command: 'flush' | 'close';
  id?: number;
}

/** The host's answer to `background-read`: the stored image (base64), or none when the file has no image beside it. */
export interface BackgroundMessage {
  type: 'draft-canvas:background';
  id: number;
  mime?: string;
  data?: string;
}

/** The host's answer to `clipboard-read`: the clipboard's text when it holds copied shapes (or, for a `plain` read, any text), otherwise empty. */
export interface ClipboardMessage {
  type: 'draft-canvas:clipboard';
  id: number;
  text: string;
}

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
  /**
   * Since protocol 4: the host reads and writes the system clipboard for the app. A key pressed in the
   * frame never becomes the host's own Copy or Paste, and the frame is refused the Clipboard API.
   */
  clipboard?: boolean;
  /**
   * Since protocol 5: the host takes part in text editing (it serves `plain` clipboard messages), so
   * the app does Select All, Copy, Cut, Paste and Undo in a text field itself.
   * Keys in the frame never become the host's Edit-menu actions, so those did nothing there.
   */
  textEditing?: boolean;
  /**
   * Since protocol 5: the chords the host runs commands for (⌘P, ⌘W and the like), so the app posts
   * `key` for exactly those. A key pressed in the frame never reaches the host's own keybindings.
   */
  keys?: string[];
  /**
   * Since protocol 6: the host keeps the canvas's background image beside the file. The app asks for it
   * (`background-read`) when the file turns one on that it doesn't hold, and reports each change.
   */
  background?: boolean;
}

/** A VS Code webview's origin. Anything else framing the app at `?host=vscode` is not its host. */
export function isHostOrigin(origin: string): boolean {
  return origin.startsWith('vscode-webview://');
}

/**
 * A key event as the name a host lists in `LoadMessage.keys`: modifiers in the order cmd, ctrl, shift
 * joined with `+`, then the lowercased key — `cmd+shift+p`. Alt never forwards.
 */
export function chordOf(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): string | null {
  if (event.altKey || event.key.length !== 1) return null;
  return [event.metaKey && 'cmd', event.ctrlKey && 'ctrl', event.shiftKey && 'shift', event.key.toLowerCase()]
    .filter(Boolean)
    .join('+');
}
