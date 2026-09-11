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

/** Rounds to the nearest whole unit — README numbers don't need decimal precision. */
function ms(value: number): string {
  return `${Math.round(value)} ms`;
}
function mib(value: number): string {
  return `${Math.round(value)} MiB`;
}

/** `os.platform()`'s raw values ('darwin', 'linux', 'win32') are correct but not what a reader
 *  expects in a README's "measured on" line. */
function friendlyOsName(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform;
  }
}

/**
 * A plain-language lead-in grounded in the actual measured numbers — never a hardcoded qualitative
 * claim ("stays fast!") that could go stale the moment a real regression lands. If a future
 * regression makes a workload slow, this sentence reports that plainly; it doesn't have an opinion
 * baked in ahead of the numbers.
 */
function buildSummary(result: BenchmarkResult): string {
  const typical = result.workloads.find((w) => w.name === 'typical') ?? result.workloads[0];
  const large = result.workloads.find((w) => w.name === 'large') ?? result.workloads[1];
  if (!typical) return '';

  const typicalSentence = `On a typical architecture diagram (~${typical.nodeCount} nodes — services, databases, queues, boundaries), Draft Canvas loads in about ${ms(typical.diagramLoad.medianMs)} and settles at about ${mib(typical.jsHeapUsedMiB)} of memory; dragging a node takes about ${ms(typical.drag.medianMs)}.`;
  const largeSentence = large
    ? ` A larger, more detailed diagram (~${large.nodeCount} nodes) loads in about ${ms(large.diagramLoad.medianMs)} and uses about ${mib(large.jsHeapUsedMiB)}.`
    : '';
  return typicalSentence + largeSentence;
}

function buildBlock(result: BenchmarkResult): string {
  const env = result.meta.environment;
  const rows = result.workloads
    .map((w) => {
      const size = `${w.nodeCount} nodes / ${w.edgeCount} connections`;
      return `| ${capitalize(w.name)} | ${size} | ${ms(w.diagramLoad.medianMs)} | ${mib(w.jsHeapUsedMiB)} | ${ms(w.drag.medianMs)} |`;
    })
    .join('\n');

  const chartLine = existsSync(CHART_PATH)
    ? '\n\n![JS heap vs. diagram size](benchmark/memory-chart.svg)'
    : '';

  return [
    START_MARKER,
    '## Performance',
    '',
    buildSummary(result),
    '',
    '| Diagram | Size | Load time | Memory (JS heap) | Dragging a node |',
    '|---|---|---|---|---|',
    rows,
    '',
    "Measured against the production build in Chromium, on real architecture diagrams (not synthetic shapes) built from Draft Canvas's own starter catalog. These are reference-machine numbers, not a guarantee for every device.",
    '',
    `Measured on: ${env.cpuModel}, ${friendlyOsName(env.os)} ${env.osVersion}, Chromium ${env.browserVersion}, Draft Canvas ${result.meta.draftCanvasVersion}.${chartLine}`,
    '',
    'Full methodology, limitations, and how to reproduce this: [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).',
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
