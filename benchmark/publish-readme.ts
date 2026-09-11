/**
 * Regenerates the `<!-- performance:start -->` … `<!-- performance:end -->` block in `README.md`
 * from `benchmark/results/latest.json` — a straightforward regex splice, not a templating system.
 * Run via `npm run perf:publish` after `npm run perf` (or `perf:stress`) to refresh the README's
 * numbers. Idempotent: running it twice on the same `latest.json` produces identical output.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchmarkResult } from './types';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_PATH = join(REPO_ROOT, 'benchmark/results/latest.json');
// Committed at the repo root, not under the gitignored `results/` — see `cli.ts`.
const CHART_PATH = join(REPO_ROOT, 'benchmark/memory-chart.svg');
const README_PATH = join(REPO_ROOT, 'README.md');

const START_MARKER = '<!-- performance:start -->';
const END_MARKER = '<!-- performance:end -->';

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildBlock(result: BenchmarkResult): string {
  const env = result.meta.environment;
  const rows = result.workloads
    .map((w) => {
      const elements = `${w.nodeCount} nodes / ${w.edgeCount} connections`;
      return `| ${capitalize(w.name)} | ${elements} | ${Math.round(w.diagramLoad.medianMs)} ms | ${Math.round(w.jsHeapUsedMiB)} MiB | ${Math.round(w.drag.medianMs)} ms |`;
    })
    .join('\n');

  const chartLine = existsSync(CHART_PATH)
    ? '\n\n![JS heap vs. diagram size](benchmark/memory-chart.svg)'
    : '';

  return [
    START_MARKER,
    '## Performance',
    '',
    'Draft Canvas includes a reproducible Chromium benchmark using a representative architecture diagram.',
    '',
    '| Scenario | Elements | Load | JS Heap | Drag |',
    '|---|---|---|---|---|',
    rows,
    '',
    'Benchmarks run against the production build in Chromium using deterministic architecture diagrams. Results are representative measurements from the reference machine below, not guarantees for every device.',
    '',
    `Measured on: ${env.cpuModel}, ${env.os} ${env.osVersion}, Chromium ${env.browserVersion}, Draft Canvas ${result.meta.draftCanvasVersion}.${chartLine}`,
    '',
    'Details and reproduction steps: [`docs/performance.md`](docs/performance.md).',
    END_MARKER,
  ].join('\n');
}

function main(): void {
  if (!existsSync(RESULTS_PATH)) {
    console.error(`No results at ${RESULTS_PATH} — run "npm run perf" first.`);
    process.exit(1);
  }
  const result = JSON.parse(readFileSync(RESULTS_PATH, 'utf-8')) as BenchmarkResult;
  const block = buildBlock(result);

  const readme = readFileSync(README_PATH, 'utf-8');
  const pattern = new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}`);
  if (!pattern.test(readme)) {
    console.error(`Could not find ${START_MARKER} / ${END_MARKER} markers in README.md.`);
    process.exit(1);
  }
  const updated = readme.replace(pattern, block);
  writeFileSync(README_PATH, updated);
  console.log('Updated README.md performance section.');
}

main();
