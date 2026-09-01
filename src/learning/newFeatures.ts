import { PRODUCT } from '../product';

/**
 * Phase 7.3 — the small catalog of "too minor for a coachmark" capabilities. Each entry names the
 * app version it shipped in; `useIsNewFeature` compares that against the version this device last
 * had open, so the badge only ever appears for someone returning after that version, never for a
 * brand-new install (see that hook's own comment).
 */
export const NEW_FEATURES: { id: string; sinceVersion: string }[] = [
  { id: 'learn-mode', sinceVersion: PRODUCT.version },
];
