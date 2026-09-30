/**
 * Best-effort request for persistent storage, to reduce (never eliminate) the
 * odds a browser evicts Draft Canvas's data under storage pressure. Browser
 * approval is optional and never assumed — this is purely a nudge, not a
 * guarantee; see docs/reference/privacy.md's storage-quota note.
 */
export function requestPersistentStorage(): void {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  navigator.storage.persist().catch(() => {
    // Ignored: nothing to react to either way.
  });
}

/**
 * Whether the browser has agreed to keep this origin's storage through pressure and, in Safari,
 * through a week of not being visited. `null` when it can't say. Asked for a warning worth showing:
 * without it, Safari can quietly delete a whole library that was never exported.
 */
export async function isStoragePersisted(): Promise<boolean | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return null;
  try {
    return await navigator.storage.persisted();
  } catch {
    return null;
  }
}
