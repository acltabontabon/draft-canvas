/**
 * Diagram-load scenario — boundary is file-input change event to DOM node count matching the
 * expected count, plus two consecutive idle animation frames. Reuses one `page`/`cdp` across
 * iterations (unlike `startup.ts`, which needs a fresh context per run to measure cold navigation).
 */

import type { CDPSession, Page } from '@playwright/test';
import { forceGC, readHeapMetrics } from '../browser';
import { summarize } from '../stats/aggregate';
import type { TimingSample, WorkloadName } from '../types';

export async function runDiagramLoad(
  page: Page,
  cdp: CDPSession,
  baseUrl: string,
  workload: { name: WorkloadName; nodeCount: number; edgeCount: number },
  fixtureBuffer: Buffer,
  iterations: number,
  warmupIterations: number,
): Promise<{ diagramLoad: TimingSample; jsHeapAfterLoadMiB: number; domNodeCountAfterLoad: number }> {
  const timings: number[] = [];
  const totalRuns = warmupIterations + iterations;

  for (let run = 0; run < totalRuns; run += 1) {
    await page.goto(`${baseUrl}/?bench=1`);
    const t0 = Date.now();
    await page.setInputFiles('input[type="file"]', {
      name: `${workload.name}.draftcanvas`,
      mimeType: 'application/json',
      buffer: fixtureBuffer,
    });
    await page.waitForFunction(
      (n) => document.querySelectorAll('.dc-node').length === n,
      workload.nodeCount,
      { timeout: 30_000 },
    );
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    const t1 = Date.now();
    if (run >= warmupIterations) timings.push(t1 - t0);
  }

  await forceGC(cdp);
  const { jsHeapUsedMiB, domNodes } = await readHeapMetrics(cdp);

  return {
    diagramLoad: summarize(timings),
    jsHeapAfterLoadMiB: jsHeapUsedMiB,
    domNodeCountAfterLoad: domNodes,
  };
}
