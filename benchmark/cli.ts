/**
 * Benchmark CLI entrypoint — `tsx benchmark/cli.ts [--stress] [--save-baseline]`.
 *
 * Builds the app, serves it via `vite preview`, measures diagram load + JS heap + drag
 * responsiveness for each workload, and writes `benchmark/results/latest.json` plus a terminal
 * summary. Answers exactly three questions: how fast does a realistic diagram load, how much
 * memory does it use, does dragging a node still feel responsive. A workload with no fixture on
 * disk (e.g. `stress` before `npm run perf:regen-fixtures` has been run) is skipped gracefully
 * rather than failing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import type { DraftDocument } from '../src/document/types';
import { launchBrowser, openCdpPage } from './browser';
import { BENCH_PORT, DEFAULT_WORKLOADS, ITERATIONS, STRESS_WORKLOADS, WARMUP_ITERATIONS } from './config';
import { collectEnvironment, getDraftCanvasVersion, getGitInfo } from './env';
import { renderMemoryChart } from './report/charts';
import { writeJsonReport } from './report/json';
import { printTerminalSummary } from './report/terminal';
import { runDiagramLoad } from './scenarios/diagramLoad';
import { runDrag } from './scenarios/drag';
import { type BenchServer, startBenchServer } from './server';
import { BENCHMARK_SCHEMA_VERSION, type BenchmarkResult, type WorkloadName, type WorkloadResult } from './types';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = join(REPO_ROOT, 'benchmark/workloads/fixtures');
const RESULTS_DIR = join(REPO_ROOT, 'benchmark/results');
const BASELINE_PATH = join(REPO_ROOT, 'benchmark/baseline.json');

function parseArgs(argv: string[]): { stress: boolean; saveBaseline: boolean } {
  return {
    stress: argv.includes('--stress'),
    saveBaseline: argv.includes('--save-baseline'),
  };
}

function readBaseline(): BenchmarkResult | undefined {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as BenchmarkResult;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const { stress, saveBaseline } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  let browser: Browser | undefined;
  let server: BenchServer | undefined;

  process.once('SIGINT', () => {
    void (async () => {
      await server?.stop();
      await browser?.close();
      process.exit(130);
    })();
  });

  try {
    browser = await launchBrowser();
    const environment = await collectEnvironment(browser.version());

    server = await startBenchServer({ port: BENCH_PORT });

    const { page, cdp } = await openCdpPage(browser);

    const workloadNames: WorkloadName[] = stress ? STRESS_WORKLOADS : DEFAULT_WORKLOADS;
    const workloads: WorkloadResult[] = [];

    for (const name of workloadNames) {
      const fixturePath = join(FIXTURES_DIR, `${name}.draftcanvas.json`);
      if (!existsSync(fixturePath)) {
        console.log(`Skipping "${name}" — no fixture on disk (run "npm run perf:regen-fixtures").`);
        continue;
      }

      const fixtureBuffer = readFileSync(fixturePath);
      const parsed = JSON.parse(fixtureBuffer.toString('utf-8')) as DraftDocument;
      const nodeCount = parsed.nodes?.length ?? 0;
      const edgeCount = parsed.edges?.length ?? 0;

      const { diagramLoad, jsHeapAfterLoadMiB } = await runDiagramLoad(
        page,
        cdp,
        server.url,
        { name, nodeCount, edgeCount },
        fixtureBuffer,
        ITERATIONS,
        WARMUP_ITERATIONS,
      );

      const drag = await runDrag(page, ITERATIONS, WARMUP_ITERATIONS);

      workloads.push({
        name,
        nodeCount,
        edgeCount,
        diagramLoad,
        jsHeapUsedMiB: jsHeapAfterLoadMiB,
        drag,
      });
    }

    const runtimeSeconds = (Date.now() - t0) / 1000;
    const { commit, branch } = getGitInfo();
    const result: BenchmarkResult = {
      meta: {
        benchmarkVersion: BENCHMARK_SCHEMA_VERSION,
        draftCanvasVersion: getDraftCanvasVersion(),
        commit,
        branch,
        timestamp: new Date().toISOString(),
        iterations: ITERATIONS,
        warmupIterations: WARMUP_ITERATIONS,
        runtimeSeconds,
        environment,
      },
      workloads,
    };

    const jsonPath = writeJsonReport(result, RESULTS_DIR);
    const relativeJsonPath = relative(REPO_ROOT, jsonPath);
    const baseline = readBaseline();

    const summary = printTerminalSummary(result, relativeJsonPath, baseline);
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(join(RESULTS_DIR, 'summary.txt'), summary);

    if (saveBaseline) {
      writeFileSync(BASELINE_PATH, JSON.stringify(result, null, 2));
      console.log(`Saved baseline: ${relative(REPO_ROOT, BASELINE_PATH)}`);
    }

    if (workloads.length >= 2) {
      // Committed at the repo root (not under the gitignored `results/`) — the README links to
      // this file directly, so it must actually be tracked by git to render on GitHub.
      const chartPath = join(REPO_ROOT, 'benchmark', 'memory-chart.svg');
      writeFileSync(chartPath, renderMemoryChart(workloads.map((w) => ({ name: w.name, nodeCount: w.nodeCount, jsHeapUsedMiB: w.jsHeapUsedMiB }))));
    }
  } finally {
    await server?.stop();
    await browser?.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
