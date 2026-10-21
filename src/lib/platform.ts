/**
 * The one place that decides how a modifier chord is spelled. macOS users read "⌘K" / "Cmd K";
 * everyone else reads "Ctrl K" — a shortcut hint that names the wrong key is worse than none.
 */
const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Compact form, for inline `<kbd>` chips: "⌘" / "Ctrl". */
export const MOD_SYMBOL = isMac ? '⌘' : 'Ctrl';

/** Same split for the Option/Alt key — used by spatial/relationship canvas navigation, which
 *  binds to this key alone, never alongside `MOD_SYMBOL`. */
export const ALT_SYMBOL = isMac ? '⌥' : 'Alt';

const MAC_KEY_SYMBOLS: Record<string, string> = { Shift: '⇧', Backspace: '⌫', Enter: '↵', Alt: '⌥' };

/** A menu's quiet shortcut hint, read past rather than parsed as key caps. A Mac menu prints the
 *  symbols run together ("⌘D", "⇧1", "⌫"); Windows and Linux menus spell the keys out and join them
 *  with `+` ("Ctrl+Shift+Z"). */
export function plainShortcut(shortcut: string, mac = isMac): string {
  const keys = shortcut.split(' ');
  return mac ? keys.map((key) => MAC_KEY_SYMBOLS[key] ?? key).join('') : keys.join('+');
}
