/**
 * Phase 7.3 — the small catalog of "too minor for a coachmark" capabilities. Each entry names the
 * app version it shipped in (a fixed historical string, per CHANGELOG.md — never `PRODUCT.version`,
 * which would make every entry look newer than any stored baseline on every single release);
 * `useIsNewFeature` compares that against the version this device last had open, so the badge only
 * ever appears for someone returning after that version, never for a brand-new install (see that
 * hook's own comment).
 */
export const NEW_FEATURES: { id: string; sinceVersion: string }[] = [
  { id: 'learn-mode', sinceVersion: '0.1.0-alpha.4' },
  { id: 'command-palette', sinceVersion: '0.2.0' },
];
