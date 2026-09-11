import type { StarterId } from '../../src/starters';
import type { WorkloadName } from '../types';

export interface WorkloadSpec {
  name: WorkloadName;
  label: string;
  targetNodes: number;
  targetEdgeRange: [min: number, max: number];
}

/**
 * The three workload sizes the default and `--stress` runs use. `targetEdgeRange`'s max is
 * `Infinity` for STRESS's "+"-style range from the original spec — always "at least N edges", not
 * a closed interval, so there's no real ceiling to encode.
 */
export const WORKLOAD_SPECS: Record<WorkloadName, WorkloadSpec> = {
  typical: { name: 'typical', label: 'Detailed architecture', targetNodes: 90, targetEdgeRange: [100, 150] },
  large: { name: 'large', label: 'Complex landscape', targetNodes: 225, targetEdgeRange: [300, 400] },
  stress: { name: 'stress', label: 'Stress test', targetNodes: 500, targetEdgeRange: [750, Infinity] },
};

export const TILE_ORDER: StarterId[] = ['microservices', 'event-driven', 'cqrs', 'hexagonal', 'saga-orchestration'];
