import type { DismissalKey } from './types';

/**
 * The key an Escaped offer is remembered under: that anchor, that rule, that exact neighborhood.
 * Its own module so the UI store can build one without loading the continuation engine.
 */
export function dismissalKey(anchorId: string, ruleId: string, neighborhoodKey: string): DismissalKey {
  return `${anchorId}|${ruleId}|${neighborhoodKey}`;
}
