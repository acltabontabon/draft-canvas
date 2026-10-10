import type { InteractionResult } from './interaction/report';
import type { ExportResult, LoadResult } from './interaction/lifecycle';

export interface LifecycleReport {
  load: LoadResult[];
  exports: Array<ExportResult & { size: string }>;
}

/** Coarse regression limits for the supported 200-shape/300-connector workload, not a 60 Hz claim.
 * Medians over three iterations absorb one noisy sample; missing/failed scenarios never pass. */
export const PERFORMANCE_BUDGET = {
  size: 'medium',
  scenarios: ['pan-drag', 'drag-single', 'select-clicks'],
  frameP95: 50,
  latencyP95: 100,
  longTaskMaxMs: 250,
  tailLongTaskMaxMs: 250,
  loadMs: 3000,
  loadLongestTaskMs: 1000,
  heapMiB: 256,
  svgMs: 1500,
  pngMs: 6000,
} as const;

export function performanceFailures(interaction: InteractionResult, lifecycle: LifecycleReport): string[] {
  const failures: string[] = [];
  const check = (name: string, value: unknown, maximum: number, wholeMilliseconds = false) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (wholeMilliseconds ? Math.round(value) : value) > maximum) {
      failures.push(`${name}: ${String(value)} exceeds ${maximum} or is invalid`);
    }
  };
  check('idle frame floor', interaction.meta?.frameFloorMs, 25);
  const fixture = interaction.fixtures?.medium;
  if (!fixture || typeof fixture !== 'object' || !('nodes' in fixture) || !('edges' in fixture) || fixture.nodes !== 200 || fixture.edges !== 300) {
    failures.push('The supported fixture must contain 200 shapes and 300 connectors');
  }
  if (!Array.isArray(interaction.scenarios) || !Array.isArray(lifecycle.load) || !Array.isArray(lifecycle.exports)) {
    return [...failures, 'Incomplete benchmark reports'];
  }
  for (const id of PERFORMANCE_BUDGET.scenarios) {
    const matches = interaction.scenarios.filter((entry) => entry.size === PERFORMANCE_BUDGET.size && entry.scenario === id);
    const scenario = matches[0];
    if (matches.length !== 1 || !scenario || !Array.isArray(scenario.iterations) || scenario.iterations.length < 3 || scenario.canvasBroken || scenario.problems?.length !== 0 || !scenario.headline) {
      failures.push(`${id}: missing, incomplete, duplicated or broken scenario`);
      continue;
    }
    for (const metric of ['frameP95', 'latencyP95', 'longTaskMaxMs', 'tailLongTaskMaxMs'] as const) {
      // Three nominal 60 Hz frames can be recorded as 50.1 ms. Compare this coarse frame gate at
      // whole-millisecond precision; keep the report's original measurement for investigation.
      check(`${id} ${metric}`, scenario.headline[metric], PERFORMANCE_BUDGET[metric], metric === 'frameP95');
    }
  }
  const load = lifecycle.load.filter((entry) => entry.size === PERFORMANCE_BUDGET.size);
  if (load.length !== 1) failures.push('Missing or duplicated medium load');
  else {
    check('medium load', load[0]!.loadMs, PERFORMANCE_BUDGET.loadMs);
    check('medium load longest task', load[0]!.longestTaskMs, PERFORMANCE_BUDGET.loadLongestTaskMs);
    check('medium heap', load[0]!.heapMiB, PERFORMANCE_BUDGET.heapMiB);
  }
  for (const kind of ['svg', 'png'] as const) {
    const exports = lifecycle.exports.filter((entry) => entry.size === PERFORMANCE_BUDGET.size && entry.kind === kind);
    if (exports.length !== 1) failures.push(`Missing or duplicated medium ${kind} export`);
    else {
      check(`${kind} export`, exports[0]!.ms, kind === 'svg' ? PERFORMANCE_BUDGET.svgMs : PERFORMANCE_BUDGET.pngMs);
      if (!(exports[0]!.bytes > 0)) failures.push(`${kind} export is empty`);
    }
  }
  return failures;
}
