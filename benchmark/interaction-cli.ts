/**
 * Interaction benchmark entrypoint —
 *
 *   tsx benchmark/interaction-cli.ts [--sizes small,medium] [--scenarios drag-single,pan-drag]
 *       [--iterations 3] [--warmup 1] [--label before] [--out path.json] [--skip-build] [--headed]
 *       [--dist /path/to/another/dist]      measure a build made elsewhere (before/after runs)
 *       [--uncap-frames]                    lift Chromium's frame-rate cap (a laptop on low battery is capped
 *                                           to 30 Hz, and every gesture would "miss" 60 Hz because of it)
 *       [--profile /path/to/dir]            CPU-profile the first measured iteration of each scenario
 *       [--against /path/to/dist] [--against-label baseline]
 *                                           measure another build *interleaved* with this one, scenario
 *                                           by scenario (order alternating), so a before and an after
 *                                           share the same machine state — energy saver, thermals, other
 *                                           work — and are compared on it, not on two different afternoons
 *   tsx benchmark/interaction-cli.ts --compare before.json after.json
 *
 * Where `benchmark/cli.ts` answers "how fast does it load and how big is it", this answers "does it
 * stay smooth while somebody works": frame-time distributions, input latency and long tasks for
 * pan, zoom, drags, connecting, hovering, selecting, typing and opening panels, on deterministic
 * fixtures from 50 to 1,000 shapes. See `docs/reference/performance.md`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, measureFrameFloor } from './browser';
import { collectEnvironment, getGitInfo } from './env';
import { formatComparison, formatRun, type InteractionResult } from './interaction/report';
import { runScenario, scenarioById, VIEWPORT } from './interaction/run';
import { SCENARIO_IDS } from './interaction/scenarios';
import { startBenchServer } from './server';
import { buildScaleDocument, SCALE_NAMES, SCALE_SPECS, type ScaleName } from './workloads/scale';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(REPO_ROOT, 'benchmark/results/interaction.json');
/** Distinct from 5180/5190 (Playwright) and 5195 (the load benchmark). */
const PORT = Number(process.env.BENCH_INTERACTION_PORT ?? 5196);

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

function list<T extends string>(value: string | undefined, all: readonly T[], what: string): T[] {
  if (!value) return [...all];
  const wanted = value.split(',').map((item) => item.trim()) as T[];
  for (const item of wanted) if (!all.includes(item)) throw new Error(`Unknown ${what} "${item}". Known: ${all.join(', ')}`);
  return wanted;
}

async function main(): Promise<void> {
  const compareAt = process.argv.indexOf('--compare');
  if (compareAt !== -1) {
    const [beforePath, afterPath] = [process.argv[compareAt + 1]!, process.argv[compareAt + 2]!];
    const read = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as InteractionResult;
    console.log(formatComparison(read(beforePath), read(afterPath)));
    return;
  }

  const sizes = list<ScaleName>(flag('sizes'), SCALE_NAMES, 'size');
  const scenarioIds = list(flag('scenarios'), SCENARIO_IDS, 'scenario');
  const iterations = Number(flag('iterations') ?? 3);
  const warmup = Number(flag('warmup') ?? 1);
  const label = flag('label') ?? 'run';
  const out = flag('out') ?? DEFAULT_OUT;
  const headed = has('headed');

  const server = await startBenchServer({ port: PORT, skipBuild: has('skip-build'), distDir: flag('dist') });
  const againstDist = flag('against');
  const against = againstDist ? await startBenchServer({ port: PORT + 1, distDir: againstDist }) : undefined;
  const againstLabel = flag('against-label') ?? 'baseline';
  const uncapFrames = has('uncap-frames');
  const browser = await launchBrowser({ ...(headed ? { headed: true } : { newHeadless: true }), uncapFrames });
  const stop = async () => {
    await browser.close().catch(() => undefined);
    await server.stop();
    await against?.stop();
  };
  process.once('SIGINT', () => void stop().then(() => process.exit(130)));

  try {
    const environment = await collectEnvironment(browser.version());
    const { commit, branch } = getGitInfo();
    const frameFloorMs = await measureFrameFloor(browser);
    console.log(`Idle frame floor: ${frameFloorMs.toFixed(1)} ms${frameFloorMs > 20 ? '  ⚠ throttled — results are not comparable with a 16.7 ms run' : ''}`);
    const fixtures: Record<string, unknown> = {};
    const summaries: InteractionResult['scenarios'] = [];
    const againstSummaries: InteractionResult['scenarios'] = [];
    let turn = 0;

    for (const size of sizes) {
      const { document, manifest } = buildScaleDocument(SCALE_SPECS[size]);
      fixtures[size] = manifest;
      const fixture = Buffer.from(JSON.stringify(document));
      console.log(
        `\n== ${size}: ${manifest.nodes} shapes / ${manifest.edges} connectors (${manifest.boundaries} boundaries, depth ${manifest.maxBoundaryDepth}, ${manifest.nodeAttachments + manifest.edgeAttachments} attachments, ${manifest.rooms} rooms)`,
      );
      for (const id of scenarioIds) {
        const scenario = scenarioById(id);
        process.stdout.write(`   ${id} … `);
        try {
          const measure = (url: string, profile?: string) =>
            runScenario(browser, url, fixture, manifest, scenario, iterations, warmup, profile);
          let summary: Awaited<ReturnType<typeof measure>>;
          if (against) {
            // Alternate who goes first, so neither build always gets the machine at its freshest.
            const first = turn % 2 === 0;
            turn += 1;
            const [a, b] = first
              ? [await measure(server.url), await measure(against.url)]
              : [await measure(against.url), await measure(server.url)].reverse();
            summary = a;
            againstSummaries.push(b);
          } else {
            summary = await measure(server.url, flag('profile'));
          }
          summaries.push(summary);
          console.log(
            summary.canvasBroken
              ? 'CANVAS BROKE'
              : `p95 ${summary.headline.frameP95.toFixed(1)} ms, max ${summary.headline.frameMax.toFixed(0)} ms${summary.problems.length > 0 ? `, ${summary.problems.length} page error(s)` : ''}`,
          );
        } catch (error) {
          console.log(`FAILED: ${(error as Error).message.split('\n')[0]}`);
        }
      }
    }

    const result: InteractionResult = {
      meta: {
        label,
        commit,
        branch,
        timestamp: new Date().toISOString(),
        iterations,
        warmup,
        headless: headed ? 'headed' : 'new headless',
        viewport: `${VIEWPORT.width}×${VIEWPORT.height} @1x`,
        build: 'production (vite build, minified)',
        frameFloorMs,
        environment,
      },
      fixtures,
      scenarios: summaries,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`\n${formatRun(result)}\n\nResults: ${out}`);
    if (against) {
      const other: InteractionResult = {
        ...result,
        meta: { ...result.meta, label: againstLabel, commit: 'baseline', branch: 'baseline' },
        scenarios: againstSummaries,
      };
      const otherOut = out.replace(/\.json$/, `.${againstLabel}.json`);
      writeFileSync(otherOut, JSON.stringify(other, null, 2));
      console.log(`\n${formatRun(other)}\n\n${formatComparison(other, result)}\n\nResults: ${otherOut}`);
    }
  } finally {
    await stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
