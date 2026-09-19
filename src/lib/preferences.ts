/**
 * Tiny UI preferences only.
 *
 * `localStorage` is synchronous and size-limited, so it holds nothing but a few
 * short strings: the theme, the grid style, the last tool. Documents live in
 * IndexedDB. Nothing here ever contains canvas content — see docs/reference/privacy.md.
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

/**
 * Keys earlier builds wrote and nothing reads any more, removed once at startup rather than left
 * sitting in `localStorage` forever. Exact keys only — never a prefix sweep, so nothing current can
 * be caught by accident.
 */
export const RETIRED_PREFERENCE_KEYS: readonly string[] = [
  // A palette pinned against the OS; the app now simply follows it. `theme` is older still: it was
  // written on every first launch, chosen or not, so its value could never be told apart from a choice.
  'theme-override',
  'theme',
  // The old Learn mode: its "New" badges and the contextual hints it retired.
  'last-seen-version',
  'feature-seen.learn-mode',
  'feature-seen.command-palette',
  'hint.service-node',
  'hint.attachment-slot',
  'hint.connector-selected',
  'hint.connector-attachment-slot',
  'hint.command-palette',
  // The palette's usage count for that mode's toggle command.
  'command-use.learn-mode',
];

export function retirePreferences(keys: readonly string[] = RETIRED_PREFERENCE_KEYS): void {
  for (const key of keys) removePreference(key);
}

export function removePreference(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Ignored.
  }
}
