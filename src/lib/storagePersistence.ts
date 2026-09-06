/**
 * Best-effort request for persistent storage, to reduce (never eliminate) the
 * odds a browser evicts Draft Canvas's data under storage pressure. Browser
 * approval is optional and never assumed — this is purely a nudge, not a
 * guarantee; see docs/PRIVACY.md's storage-quota note.
 */
export function requestPersistentStorage(): void {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  navigator.storage.persist().catch(() => {
    // Ignored: nothing to react to either way.
  });
}
