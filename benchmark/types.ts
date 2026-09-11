/**
 * Minimal result schema for the browser performance benchmark harness — answers exactly three
 * questions: how fast does a realistic diagram load, how much memory does it use, does dragging a
 * node still feel responsive. No percentiles, no frame/long-task instrumentation, no scaling
 * sweep, no environment-compatibility gating — see `docs/PERFORMANCE.md` for the full rationale.
 */

export const BENCHMARK_SCHEMA_VERSION = 1;

export interface BenchmarkEnvironment {
  os: string;
  osVersion: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryMiB: number;
  browser: 'chromium';
  browserVersion: string;
  nodeVersion: string;
}

export interface TimingSample {
  medianMs: number;
  minMs: number;
  maxMs: number;
  samples: number;
}

export type WorkloadName = 'typical' | 'large' | 'stress';

export interface WorkloadResult {
  name: WorkloadName;
  nodeCount: number;
  edgeCount: number;
  diagramLoad: TimingSample;
  jsHeapUsedMiB: number;
  drag: TimingSample;
}

export interface BenchmarkMeta {
  benchmarkVersion: number;
  draftCanvasVersion: string;
  commit: string;
  branch: string;
  timestamp: string;
  iterations: number;
  warmupIterations: number;
  runtimeSeconds: number;
  environment: BenchmarkEnvironment;
}

export interface BenchmarkResult {
  meta: BenchmarkMeta;
  workloads: WorkloadResult[];
}
