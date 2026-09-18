/**
 * Terminal tables for the interaction benchmark: one run on its own, and two runs side by side.
 * Numbers are milliseconds unless a column says otherwise. The comparison is deliberately plain —
 * a before and an after with the change between them — because with a handful of iterations a
 * threshold or a verdict would be false precision.
 */

import type { BenchmarkEnvironment } from '../types';
import type { ScenarioSummary } from './run';

export interface InteractionResult {
  meta: {
    label: string;
    commit: string;
    branch: string;
    timestamp: string;
    iterations: number;
    warmup: number;
    headless: string;
    viewport: string;
    build: string;
    /** An idle page's frame time here, ms. 16.7 is a 60 Hz machine; 33.3 means it was throttled. */
    frameFloorMs: number;
    environment: BenchmarkEnvironment;
  };
  fixtures: Record<string, unknown>;
  scenarios: ScenarioSummary[];
  lifecycle?: Record<string, unknown>;
}

const num = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : '–');
const pad = (text: string, width: number) => text.padEnd(width);
const padLeft = (text: string, width: number) => text.padStart(width);

export function formatRun(result: InteractionResult): string {
  const lines: string[] = [];
  const { meta } = result;
  lines.push(`Interaction benchmark — ${meta.label}`);
  lines.push(
    `${meta.environment.os} ${meta.environment.arch} · ${meta.environment.cpuModel} · Chromium ${meta.environment.browserVersion} (${meta.headless}) · ${meta.viewport} · ${meta.build}`,
  );
  lines.push(`${meta.branch} @ ${meta.commit.slice(0, 9)} · ${meta.iterations} measured iterations after ${meta.warmup} warmup`);
  lines.push(
    `idle frame floor ${meta.frameFloorMs.toFixed(1)} ms${meta.frameFloorMs > 20 ? '  ⚠ THROTTLED (energy saver / battery?) — frame times below are not comparable with a 16.7 ms run' : ''}`,
  );
  lines.push('');
  lines.push(
    `${pad('size', 7)}${pad('scenario', 15)}${padLeft('p50', 6)}${padLeft('p95', 7)}${padLeft('p99', 7)}${padLeft('max', 8)}${padLeft('>20ms%', 8)}${padLeft('>33ms%', 8)}${padLeft('stalls', 7)}${padLeft('lat95', 7)}${padLeft('LT#', 5)}${padLeft('LTmax', 7)}${padLeft('busy%', 7)}${padLeft('tailLT', 7)}${padLeft('tailMax', 8)}`,
  );
  for (const scenario of result.scenarios) {
    const h = scenario.headline;
    const flag = scenario.canvasBroken ? '  ✘ CANVAS BROKE' : scenario.problems.length > 0 ? `  ⚠ ${scenario.problems.length} page error(s)` : '';
    lines.push(
      `${pad(scenario.size, 7)}${pad(scenario.scenario, 15)}${padLeft(num(h.frameP50), 6)}${padLeft(num(h.frameP95), 7)}${padLeft(num(h.frameP99), 7)}${padLeft(num(h.frameMax, 0), 8)}${padLeft(num(h.droppedPct), 8)}${padLeft(num(h.hitchPct), 8)}${padLeft(num(h.stalls, 0), 7)}${padLeft(num(h.latencyP95, 0), 7)}${padLeft(num(h.longTasks, 0), 5)}${padLeft(num(h.longTaskMaxMs, 0), 7)}${padLeft(num(h.busyPct, 0), 7)}${padLeft(num(h.tailLongTasks, 0), 7)}${padLeft(num(h.tailMaxFrameMs, 0), 8)}${flag}`,
    );
  }
  lines.push('');
  lines.push('p50/p95/p99/max = frame time in ms during the gesture (16.7 = one 60 Hz frame); >20ms% and >33ms% = share of');
  lines.push('frames past that; stalls = frames > 50 ms; lat95 = pointer event → next frame, p95; LT = long tasks (count, worst ms);');
  lines.push('busy% = main-thread task time ÷ gesture wall time; tailLT / tailMax = long tasks and worst frame in the 0.4–1.6 s after.');
  for (const scenario of result.scenarios) {
    for (const problem of scenario.problems) lines.push(`  [${scenario.size}/${scenario.scenario}] ${problem}`);
  }
  return lines.join('\n');
}

const delta = (before: number, after: number) => {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return '–';
  if (before === 0 && after === 0) return '0';
  if (before === 0) return `+${num(after)}`;
  const pct = ((after - before) / before) * 100;
  return `${pct >= 0 ? '+' : ''}${num(pct, 0)}%`;
};

export function formatComparison(before: InteractionResult, after: InteractionResult): string {
  const lines: string[] = [];
  lines.push(`Comparison — ${before.meta.label} → ${after.meta.label}`);
  lines.push(`${before.meta.branch} @ ${before.meta.commit.slice(0, 9)}  →  ${after.meta.branch} @ ${after.meta.commit.slice(0, 9)}`);
  lines.push('');
  lines.push(
    `${pad('size', 7)}${pad('scenario', 15)}${padLeft('p95 ms', 16)}${padLeft('p99 ms', 16)}${padLeft('max ms', 16)}${padLeft('>33ms%', 14)}${padLeft('busy%', 14)}${padLeft('LT max', 14)}${padLeft('tail LT max', 16)}`,
  );
  const key = (s: ScenarioSummary) => `${s.size}/${s.scenario}`;
  const beforeByKey = new Map(before.scenarios.map((s) => [key(s), s]));
  for (const current of after.scenarios) {
    const previous = beforeByKey.get(key(current));
    if (!previous) continue;
    const a = previous.headline;
    const b = current.headline;
    const cell = (x: number, y: number, digits = 1) => padLeft(`${num(x, digits)}→${num(y, digits)} ${delta(x, y)}`, 16);
    lines.push(
      `${pad(current.size, 7)}${pad(current.scenario, 15)}${cell(a.frameP95, b.frameP95)}${cell(a.frameP99, b.frameP99)}${cell(a.frameMax, b.frameMax, 0)}${padLeft(`${num(a.hitchPct)}→${num(b.hitchPct)}`, 14)}${padLeft(`${num(a.busyPct, 0)}→${num(b.busyPct, 0)}`, 14)}${padLeft(`${num(a.longTaskMaxMs, 0)}→${num(b.longTaskMaxMs, 0)}`, 14)}${cell(a.tailLongTaskMaxMs, b.tailLongTaskMaxMs, 0)}`,
    );
  }
  return lines.join('\n');
}
