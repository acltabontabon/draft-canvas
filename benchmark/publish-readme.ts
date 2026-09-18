/**
 * Regenerates the `<!-- performance:start -->` … `<!-- performance:end -->` block in `README.md`
 * from `benchmark/results/latest.json` — a straightforward regex splice, not a templating system.
 * Run via `npm run perf:publish` after `npm run perf` (or `perf:stress`) to refresh the README's
 * numbers. Idempotent: running it twice on the same `latest.json` produces identical output.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InteractionResult } from './interaction/report';
import type { ExportResult, LibraryResult, LoadResult, SoakResult } from './interaction/lifecycle';
import type { BenchmarkResult } from './types';
import { SCALE_SPECS, type ScaleName } from './workloads/scale';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_PATH = join(REPO_ROOT, 'benchmark/results/latest.json');
// Optional: `npm run perf:interaction` — the frame-time half of the story. Absent means the README
// simply carries the load/memory/drag table it always did.
const INTERACTION_PATH = join(REPO_ROOT, 'benchmark/results/interaction.json');
// Optional: `npm run perf:lifecycle` — opening, exporting and long sessions.
const LIFECYCLE_PATH = join(REPO_ROOT, 'benchmark/results/lifecycle.json');
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

  const typicalSentence = `On a typical architecture diagram (~${typical.nodeCount} nodes — services, databases, queues, boundaries), Draft Canvas loads in about ${ms(typical.diagramLoad.medianMs)} and settles at about ${mib(typical.jsHeapUsedMiB)} of memory.`;
  const largeSentence = large
    ? ` A larger, more detailed diagram (~${large.nodeCount} nodes) loads in about ${ms(large.diagramLoad.medianMs)} and uses about ${mib(large.jsHeapUsedMiB)}.`
    : '';
  return typicalSentence + largeSentence;
}

/** The scenarios whose end is a commit — the drop, the connector, the rename — where a stall lives. */
const COMMIT_SCENARIOS = ['drag-single', 'drag-multi', 'drag-boundary', 'drag-note', 'connect', 'type-label'];

const SIZE_LABELS: Record<string, string> = { small: 'Small', medium: 'Medium', large: 'Large', stress: 'Stress' };

/**
 * "While you work": the frame times a person actually feels, from the interaction benchmark. Every
 * cell is a real measurement of the diagrams listed, never a claim: a frame is on time at 16.7 ms
 * (60 Hz), and the last column is the longest single freeze after finishing a drag, a connector or a
 * rename — the thing an average frame rate hides.
 */
function buildInteractionSection(interaction: InteractionResult): string {
  const sizes = ['medium', 'large', 'stress'].filter((size) => interaction.scenarios.some((s) => s.size === size));
  if (sizes.length === 0) return '';
  const headline = (size: string, scenario: string) => interaction.scenarios.find((s) => s.size === size && s.scenario === scenario)?.headline;
  const frame = (value: number | undefined) => (value === undefined ? '–' : `${value.toFixed(1)} ms`);
  const worst = (size: string, scenarios: string[], read: (h: NonNullable<ReturnType<typeof headline>>) => number) => {
    const values = scenarios.map((scenario) => headline(size, scenario)).filter((h) => h !== undefined).map((h) => read(h!));
    return values.length === 0 ? undefined : Math.max(...values);
  };

  const fixtures = interaction.fixtures as Record<string, { nodes: number; edges: number } | undefined>;
  const rows = sizes.map((size) => {
    const fixture = fixtures[size];
    const label = `${SIZE_LABELS[size] ?? size} — ${fixture?.nodes.toLocaleString('en-US')} shapes / ${fixture?.edges.toLocaleString('en-US')} connectors`;
    const pan = worst(size, ['pan-drag', 'pan-wheel'], (h) => h.frameP95);
    const zoom = worst(size, ['zoom-wheel'], (h) => h.frameP95);
    const select = worst(size, ['select-clicks'], (h) => h.frameP95);
    const drag = worst(size, ['drag-single', 'drag-multi', 'drag-boundary'], (h) => h.frameP95);
    const freeze = worst(size, COMMIT_SCENARIOS, (h) => h.longTaskMaxMs);
    const freezeText = freeze === undefined ? '–' : freeze < 50 ? 'none over 50 ms' : `${Math.round(freeze)} ms`;
    return `| ${label} | ${frame(pan)} | ${frame(zoom)} | ${frame(select)} | ${frame(drag)} | ${freezeText} |`;
  });

  return [
    '**While you work.** How long a frame takes while panning, zooming, selecting and dragging in a big diagram (95th percentile; 16.7 ms is one frame at 60 Hz), and the longest freeze after dropping a shape, drawing a connector or renaming one:',
    '',
    '| Diagram | Pan | Zoom | Select a shape | Drag | Longest freeze after an edit |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    `These diagrams are generated, deliberately dense ones: boundaries nested three deep, connectors that cross boundaries and each other, notes and code on shapes and connectors, and shapes with a room inside. Measured with real mouse input against the production build (${interaction.meta.headless} Chromium ${interaction.meta.environment.browserVersion}, ${interaction.meta.viewport}, ${interaction.meta.iterations} runs each).`,
  ].join('\n');
}

/** A whole-action time: milliseconds under a second, then seconds — "2.8 s" reads better than "2805 ms". */
const duration = (value: number) => (value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`);

interface LifecycleResult {
  load: LoadResult[];
  exports: Array<ExportResult & { size: string }>;
  library?: LibraryResult;
  soak: SoakResult[];
}

/**
 * "Opening one, and working for a long time": what choosing a big diagram costs before it is on screen
 * (and how long the page cannot respond while it does), what exporting it costs, and whether memory
 * settles over a long session. Every clause here is derived from the numbers — "stopped growing" is
 * only said when the last third of the soak really was flat — so a regression reads as one.
 */
function buildLifecycleSection(life: LifecycleResult): string {
  if (life.load.length === 0) return '';
  const exported = (size: string, kind: 'svg' | 'png') => life.exports.find((e) => e.size === size && e.kind === kind);
  const rows = life.load.map((load) => {
    const spec = SCALE_SPECS[load.size as ScaleName];
    const label = spec ? `${spec.label} — ${spec.nodes.toLocaleString('en-US')} shapes / ${spec.edges.toLocaleString('en-US')} connectors` : load.size;
    const svg = exported(load.size, 'svg');
    const png = exported(load.size, 'png');
    return `| ${label} | ${duration(load.loadMs)} | ${duration(load.longestTaskMs)} | ${svg && png ? `${duration(svg.ms)} / ${duration(png.ms)}` : '–'} |`;
  });

  const sentences: string[] = [];
  if (life.library) sentences.push(`${life.library.diagrams} saved diagrams show up in the library in ${duration(life.library.readyMs)}.`);
  const switching = life.soak.find((s) => s.label.startsWith('switch'));
  if (switching) {
    const clean = Math.abs(switching.domNodes.perCycle) < 1 && Math.abs(switching.listeners.perCycle) < 1;
    const leftBehind = clean
      ? 'and left no DOM nodes or listeners behind'
      : `and left ${switching.domNodes.perCycle.toFixed(0)} DOM nodes and ${switching.listeners.perCycle.toFixed(0)} listeners behind each time`;
    sentences.push(`Switching between diagrams ${switching.cycles} times grew the JS heap by ${switching.heap.totalMiB.toFixed(1)} MiB in total, ${leftBehind}.`);
  }
  const editing = life.soak.find((s) => s.label.startsWith('drag out and back'));
  if (editing && editing.samples.length >= 6) {
    const heap = editing.samples.map((s) => s.heapMiB);
    const tail = heap.slice(-Math.floor(heap.length / 3));
    const flat = Math.max(...tail) - Math.min(...tail) < 2;
    const size = /\((\w+)\)/.exec(editing.label)?.[1] ?? 'large';
    sentences.push(
      `Dragging a shape out and back ${editing.cycles} times on the ${size} diagram — enough to fill the undo history — took the heap from ${mib(heap[0]!)} to ${mib(heap[heap.length - 1]!)}${flat ? ', where it stopped growing' : ', and it was still growing'}.`,
    );
  }

  return [
    '**Opening one, and working for a long time.** How long a diagram takes to appear after you choose it, the longest stretch the page cannot respond in that time, and what exporting it costs (SVG / PNG):',
    '',
    '| Diagram | Opens in | Longest freeze while opening | Export |',
    '|---|---|---|---|',
    ...rows,
    '',
    sentences.join(' '),
  ].join('\n');
}

function buildBlock(result: BenchmarkResult, interaction?: InteractionResult, lifecycle?: LifecycleResult): string {
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
    '| Diagram | Size | Load time | Memory (JS heap) | 40-step drag |',
    '|---|---|---|---|---|',
    rows,
    '',
    "Measured against the production build in Chromium, on real architecture diagrams (not synthetic shapes) built from Draft Canvas's own starter catalog. These are reference-machine numbers, not a guarantee for every device. The drag column is how long a scripted 40-step drag takes end to end — one step per frame at 60 Hz, so it is the length of the gesture rather than any lag in it; how each frame fares is in the next table.",
    '',
    `Measured on: ${env.cpuModel}, ${friendlyOsName(env.os)} ${env.osVersion}, Chromium ${env.browserVersion}, Draft Canvas ${result.meta.draftCanvasVersion}.${chartLine}`,
    '',
    ...(interaction ? [buildInteractionSection(interaction), ''] : []),
    ...(lifecycle ? [buildLifecycleSection(lifecycle), ''] : []),
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
  const interaction = existsSync(INTERACTION_PATH)
    ? (JSON.parse(readFileSync(INTERACTION_PATH, 'utf-8')) as InteractionResult)
    : undefined;
  const lifecycle = existsSync(LIFECYCLE_PATH)
    ? (JSON.parse(readFileSync(LIFECYCLE_PATH, 'utf-8')) as LifecycleResult)
    : undefined;
  const block = buildBlock(result, interaction, lifecycle);

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
