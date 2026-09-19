/**
 * Lifecycle benchmark entrypoint —
 *
 *   tsx benchmark/lifecycle-cli.ts [--sizes small,medium] [--label before] [--out path.json]
 *       [--skip-build] [--dist /path/to/dist] [--library 100] [--soak-cycles 25] [--edit-cycles 150]
 *       [--only load,export,library,soak-switch,soak-edit]
 *
 * The other half of `interaction-cli.ts`: not a gesture but a whole action — open a diagram, export
 * it, find it among a hundred, or work for a long session — and whether memory settles after doing
 * the same things over and over. See `docs/reference/performance.md`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser';
import { collectEnvironment, getGitInfo } from './env';
import {
  measureExport,
  measureLibrary,
  measureLoad,
  soakEditing,
  soakSwitching,
  type ExportResult,
  type LibraryResult,
  type LoadResult,
  type SoakResult,
} from './interaction/lifecycle';
import { openFixture } from './interaction/run';
import { startBenchServer } from './server';
import { buildScaleDocument, SCALE_NAMES, SCALE_SPECS, type ScaleName } from './workloads/scale';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.BENCH_LIFECYCLE_PORT ?? 5197);

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

const ALL = ['load', 'export', 'library', 'soak-switch', 'soak-edit'] as const;
type Part = (typeof ALL)[number];

async function main(): Promise<void> {
  const sizes = (flag('sizes')?.split(',') ?? ['small', 'medium', 'large', 'stress']) as ScaleName[];
  for (const size of sizes) if (!SCALE_NAMES.includes(size)) throw new Error(`Unknown size "${size}".`);
  const parts = (flag('only')?.split(',') ?? [...ALL]) as Part[];
  const label = flag('label') ?? 'run';
  const out = flag('out') ?? join(REPO_ROOT, 'benchmark/results/lifecycle.json');
  const libraryCount = Number(flag('library') ?? 100);
  const soakCycles = Number(flag('soak-cycles') ?? 25);
  const editCycles = Number(flag('edit-cycles') ?? 150);

  const server = await startBenchServer({ port: PORT, skipBuild: process.argv.includes('--skip-build'), distDir: flag('dist') });
  const browser = await launchBrowser({ newHeadless: true });
  const stop = async () => {
    await browser.close().catch(() => undefined);
    await server.stop();
  };
  process.once('SIGINT', () => void stop().then(() => process.exit(130)));

  const result: {
    meta: Record<string, unknown>;
    load: LoadResult[];
    exports: Array<ExportResult & { size: string }>;
    library?: LibraryResult;
    soak: SoakResult[];
  } = { meta: {}, load: [], exports: [], soak: [] };

  try {
    const { commit, branch } = getGitInfo();
    result.meta = { label, commit, branch, timestamp: new Date().toISOString(), environment: await collectEnvironment(browser.version()) };

    for (const size of sizes) {
      const { document, manifest } = buildScaleDocument(SCALE_SPECS[size]);
      const fixture = Buffer.from(JSON.stringify(document));
      if (parts.includes('load')) {
        process.stdout.write(`load ${size} … `);
        const load = await measureLoad(browser, server.url, fixture, manifest, 3);
        result.load.push(load);
        console.log(`${load.loadMs.toFixed(0)} ms, longest task ${load.longestTaskMs.toFixed(0)} ms, heap ${load.heapMiB.toFixed(0)} MiB`);
      }
      if (parts.includes('export') && size !== 'small') {
        const { page } = await openFixture(browser, server.url, fixture, manifest);
        for (const kind of ['svg', 'png'] as const) {
          process.stdout.write(`export ${kind} ${size} … `);
          try {
            const exported = await measureExport(page, kind);
            result.exports.push({ ...exported, size });
            console.log(`${exported.ms.toFixed(0)} ms, longest task ${exported.longestTaskMs.toFixed(0)} ms, ${(exported.bytes / 1024).toFixed(0)} KiB`);
          } catch (error) {
            console.log(`FAILED: ${(error as Error).message.split('\n')[0]}`);
          }
        }
        await page.context().close();
      }
    }

    if (parts.includes('library')) {
      process.stdout.write(`library × ${libraryCount} … `);
      result.library = await measureLibrary(browser, server.url, libraryCount);
      console.log(`${result.library.readyMs.toFixed(0)} ms to show ${result.library.rows} rows, longest task ${result.library.longestTaskMs.toFixed(0)} ms`);
    }
    if (parts.includes('soak-switch')) {
      process.stdout.write('soak: open / edit / switch … ');
      const soak = await soakSwitching(browser, server.url, 'medium', soakCycles, Math.min(5, Math.floor(soakCycles / 3)));
      result.soak.push(soak);
      console.log(`heap ${soak.heap.perCycleMiB >= 0 ? '+' : ''}${soak.heap.perCycleMiB.toFixed(3)} MiB/cycle (fit total ${soak.heap.totalMiB.toFixed(2)}), DOM ${soak.domNodes.perCycle.toFixed(1)}/cycle, listeners ${soak.listeners.perCycle.toFixed(1)}/cycle`);
    }
    if (parts.includes('soak-edit')) {
      process.stdout.write('soak: drag out and back … ');
      const soak = await soakEditing(browser, server.url, 'large', editCycles, Math.min(20, Math.floor(editCycles / 3)));
      result.soak.push(soak);
      console.log(`heap ${soak.heap.perCycleMiB >= 0 ? '+' : ''}${soak.heap.perCycleMiB.toFixed(3)} MiB/cycle (fit total ${soak.heap.totalMiB.toFixed(2)}), DOM ${soak.domNodes.perCycle.toFixed(1)}/cycle, listeners ${soak.listeners.perCycle.toFixed(1)}/cycle`);
    }

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`\nResults: ${out}`);
  } finally {
    await stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
