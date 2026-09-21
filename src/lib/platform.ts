/**
 * The one place that decides how a modifier chord is spelled. macOS users read "⌘K" / "Cmd K";
 * everyone else reads "Ctrl K" — a shortcut hint that names the wrong key is worse than none.
 */
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * Whether a chord was made with this platform's own command key and not the other one — ⌘ on a Mac,
 * Ctrl elsewhere. On a Mac, Ctrl+A and Ctrl+Y in a text field are the system's own line editing
 * (start of line, yank), not Select All and Redo.
 */
export function isCommandChord(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Compact form, for inline `<kbd>` chips: "⌘" / "Ctrl". */
export const MOD_SYMBOL = isMac ? '⌘' : 'Ctrl';

/** Same split for the Option/Alt key — used by spatial/relationship canvas navigation, which
 *  binds to this key alone, never alongside `MOD_SYMBOL`. */
export const ALT_SYMBOL = isMac ? '⌥' : 'Alt';
