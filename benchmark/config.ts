import type { WorkloadName } from './types';

/** Distinct from the 5180/5190 already used by `playwright.config.ts`/`playwright.dist.config.ts`. */
export const BENCH_PORT = 5195;

export const ITERATIONS = 3;
export const WARMUP_ITERATIONS = 1;

export const DEFAULT_WORKLOADS: WorkloadName[] = ['typical', 'large'];
export const STRESS_WORKLOADS: WorkloadName[] = ['typical', 'large', 'stress'];
