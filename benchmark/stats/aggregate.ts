import type { TimingSample } from '../types';

/** Nearest-rank median on a sorted copy of `values`. With only 3-5 samples per run, a percentile
 *  beyond the median would be false statistical precision — see `docs/PERFORMANCE.md`. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.5 * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index]!;
}

export function summarize(valuesMs: number[]): TimingSample {
  return {
    medianMs: median(valuesMs),
    minMs: Math.min(...valuesMs),
    maxMs: Math.max(...valuesMs),
    samples: valuesMs.length,
  };
}
