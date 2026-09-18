/**
 * Distribution statistics for the interaction benchmark. An average frame rate hides exactly what a
 * person feels — one 120 ms hitch in a smooth drag — so everything here is a percentile, a count of
 * frames past a budget, or a worst case.
 */

/** A 60 Hz frame budget, and the two thresholds that read as "a frame was missed" and "a visible hitch". */
export const FRAME_BUDGET_MS = 1000 / 60;
export const DROPPED_MS = 20;
export const HITCH_MS = 33.4;
export const STALL_MS = 50;

/** Nearest-rank percentile on an already-sorted array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)]!;
}

export interface Distribution {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  };
}

export interface FrameStats extends Distribution {
  /** Share of frames slower than 20 ms — a missed 60 Hz deadline. */
  droppedPct: number;
  /** Share slower than ~2 frames (33.4 ms) — a hitch someone sees. */
  hitchPct: number;
  /** Frames slower than 50 ms — the threshold the platform itself calls a long task. */
  stalls: number;
}

export function frameStats(frames: readonly number[]): FrameStats {
  const base = distribution(frames);
  const share = (threshold: number) =>
    frames.length === 0 ? 0 : (frames.filter((value) => value > threshold).length / frames.length) * 100;
  return {
    ...base,
    droppedPct: share(DROPPED_MS),
    hitchPct: share(HITCH_MS),
    stalls: frames.filter((value) => value > STALL_MS).length,
  };
}

/** Median of a list, for aggregating one number across iterations. */
export function median(values: readonly number[]): number {
  return percentile([...values].sort((a, b) => a - b), 50);
}

/**
 * Least-squares slope of `values` against their index — how much a series grows per step. Used for
 * memory settling: a series that plateaus has a slope near zero once the warmup is dropped, while
 * a retained object graph keeps climbing. Returns the slope and the fitted total change.
 */
export function slope(values: readonly number[]): { perStep: number; total: number; r2: number } {
  const n = values.length;
  if (n < 2) return { perStep: 0, total: 0, r2: 0 };
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((total, value) => total + value, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    const dy = values[i]! - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  const perStep = varianceX === 0 ? 0 : covariance / varianceX;
  const r2 = varianceX === 0 || varianceY === 0 ? 0 : (covariance * covariance) / (varianceX * varianceY);
  return { perStep, total: perStep * (n - 1), r2 };
}
