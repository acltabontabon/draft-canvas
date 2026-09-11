/**
 * Single-node drag — the first `.dc-node`, a concrete and deterministic target so results are
 * comparable run to run and workload to workload. Mirrors `e2e/scale.spec.ts`'s proven 40-step
 * diagonal-nudge pattern. Diagnostic-only frame/long-task instrumentation is out of scope for this
 * benchmark — this returns a plain timing sample.
 */

import type { Page } from '@playwright/test';
import { summarize } from '../stats/aggregate';
import type { TimingSample } from '../types';

/** `e2e/scale.spec.ts`'s exact diagonal-nudge drag step pattern. */
const DRAG_STEP_COUNT = 40;
const DRAG_STEP_DX = 3.5;
const DRAG_STEP_DY = 1.75;

async function dragGesture(page: Page): Promise<void> {
  const node = page.locator('.dc-node').first();
  const box = (await node.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= DRAG_STEP_COUNT; step += 1) {
    await page.mouse.move(startX + step * DRAG_STEP_DX, startY + step * DRAG_STEP_DY);
  }
  await page.mouse.up();
}

/**
 * Runs the drag gesture across `warmupIterations + iterations` runs, discarding warmup timing.
 * After each *measured* run, presses the same `Meta+z` undo shortcut `e2e/scale.spec.ts` already
 * proves works in this repo's CI, restoring the node's position so the next iteration starts from
 * the same place and results stay comparable.
 */
export async function runDrag(page: Page, iterations: number, warmupIterations: number): Promise<TimingSample> {
  const timings: number[] = [];
  const totalRuns = warmupIterations + iterations;

  for (let run = 0; run < totalRuns; run += 1) {
    const t0 = Date.now();
    await dragGesture(page);
    const t1 = Date.now();
    await page.keyboard.press('Meta+z');
    if (run >= warmupIterations) timings.push(t1 - t0);
  }

  return summarize(timings);
}
