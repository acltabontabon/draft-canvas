/**
 * Best-effort request for persistent storage (Phase 6.6), to reduce (never
 * eliminate) the odds a browser evicts Draft Canvas's data under storage
 * pressure. Browser approval is optional and never assumed — this is purely
 * a nudge, not a guarantee; see docs/ROADMAP.md's storage caveat.
 */
export function requestPersistentStorage(): void {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
  navigator.storage.persist().catch(() => {
    // Ignored: nothing to react to either way.
  });
}
