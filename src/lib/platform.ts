/**
 * The one place that decides how a modifier chord is spelled. macOS users read "⌘K" / "Cmd K";
 * everyone else reads "Ctrl K" — a shortcut hint that names the wrong key is worse than none.
 */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Compact form, for inline `<kbd>` chips: "⌘" / "Ctrl". */
export const MOD_SYMBOL = isMac ? '⌘' : 'Ctrl';

/** Same split for the Option/Alt key — used by spatial/relationship canvas navigation, which
 *  binds to this key alone, never alongside `MOD_SYMBOL`. */
export const ALT_SYMBOL = isMac ? '⌥' : 'Alt';
