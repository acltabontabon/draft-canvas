/**
 * The one place that decides how a modifier chord is spelled. macOS users read "⌘K" / "Cmd K";
 * everyone else reads "Ctrl K" — a shortcut hint that names the wrong key is worse than none.
 */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Long form, for the shortcuts sheet and tooltips: "Cmd" / "Ctrl". */
export const MOD_LABEL = isMac ? 'Cmd' : 'Ctrl';

/** Compact form, for inline `<kbd>` chips: "⌘" / "Ctrl". */
export const MOD_SYMBOL = isMac ? '⌘' : 'Ctrl';
