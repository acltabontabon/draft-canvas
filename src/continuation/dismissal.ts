import type { DismissalKey } from './types';

/** The candidate slot of a dismissal that covers every candidate at that anchor. */
export const ANY_CANDIDATE = '*';

/**
 * The key an Escaped offer is remembered under: that anchor, that candidate (or `ANY_CANDIDATE`),
 * that exact neighborhood. Its own module so the UI store can build one without loading the
 * continuation engine.
 */
export function dismissalKey(anchorId: string, candidateId: string, neighborhoodKey: string): DismissalKey {
  return `${anchorId}|${candidateId}|${neighborhoodKey}`;
}
