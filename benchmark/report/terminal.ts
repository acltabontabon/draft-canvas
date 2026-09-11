import type { BenchmarkResult } from '../types';

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function pctDiff(current: number, baseline: number): string {
  if (baseline === 0) return 'n/a';
  const diff = ((current - baseline) / baseline) * 100;
  const sign = diff >= 0 ? '+' : '';
  return `${sign}${diff.toFixed(1)}%`;
}

/**
 * Builds the exact terminal summary text (also written verbatim to `results/summary.txt` so CI's
 * job-summary step can `cat` it rather than re-deriving formatting logic in the workflow YAML).
 * The "Compared with baseline" block is only included when `baseline` is given and has at least
 * one workload name matching this run's — otherwise it's omitted entirely, not printed empty.
 */
export function buildTerminalSummary(
  result: BenchmarkResult,
  resultsPath: string,
  baseline?: BenchmarkResult,
): string {
  const lines: string[] = ['Draft Canvas Performance', ''];

  for (const workload of result.workloads) {
    lines.push(`${capitalize(workload.name)} (${workload.nodeCount} nodes / ${workload.edgeCount} edges)`);
    lines.push(`  Load       ${Math.round(workload.diagramLoad.medianMs)} ms`);
    lines.push(`  JS Heap    ${Math.round(workload.jsHeapUsedMiB)} MiB`);
    lines.push(`  Drag       ${Math.round(workload.drag.medianMs)} ms`);
    lines.push('');
  }

  if (baseline) {
    const comparisons: string[] = [];
    for (const workload of result.workloads) {
      const base = baseline.workloads.find((w) => w.name === workload.name);
      if (!base) continue;
      const label = capitalize(workload.name);
      comparisons.push(`  ${label} Load    ${pctDiff(workload.diagramLoad.medianMs, base.diagramLoad.medianMs)}`);
      comparisons.push(`  ${label} Heap    ${pctDiff(workload.jsHeapUsedMiB, base.jsHeapUsedMiB)}`);
      comparisons.push(`  ${label} Drag    ${pctDiff(workload.drag.medianMs, base.drag.medianMs)}`);
    }
    if (comparisons.length > 0) {
      lines.push('Compared with baseline:');
      lines.push(...comparisons);
      lines.push('');
    }
  }

  const env = result.meta.environment;
  lines.push(`Environment: ${env.os} ${env.arch} · Chromium ${env.browserVersion} · Node ${env.nodeVersion}`);
  lines.push(`Runtime: ${result.meta.runtimeSeconds.toFixed(1)}s`);
  lines.push('');
  lines.push(`Results: ${resultsPath}`);

  return lines.join('\n');
}

export function printTerminalSummary(result: BenchmarkResult, resultsPath: string, baseline?: BenchmarkResult): string {
  const summary = buildTerminalSummary(result, resultsPath, baseline);
  console.log('');
  console.log(summary);
  console.log('');
  return summary;
}
