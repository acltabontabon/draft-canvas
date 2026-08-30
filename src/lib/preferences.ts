/**
 * Tiny UI preferences only.
 *
 * `localStorage` is synchronous and size-limited, so it holds nothing but a few
 * short strings: the theme, the grid style, the last tool. Documents live in
 * IndexedDB. Nothing here ever contains canvas content — see docs/PRIVACY.md.
 */
const PREFIX = 'draft-canvas.';

/** A hard cap; anything longer is a bug, not a preference. */
const MAX_LENGTH = 64;

export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(PREFIX + key);
  } catch {
    // Private browsing or a blocked-storage policy. Preferences are optional.
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  if (value.length > MAX_LENGTH) return;
  try {
    localStorage.setItem(PREFIX + key, value);
  } catch {
    // Ignored: losing a preference is not worth interrupting the user.
  }
}

export function removePreference(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Ignored.
  }
}
