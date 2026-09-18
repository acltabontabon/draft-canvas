/**
 * Runs one scenario on one fixture and reduces what the page recorded to numbers a person can
 * compare across commits. The unit of measurement is a *gesture window* — the frames between the
 * first and last input — followed by a *tail* in which nothing is being touched but the debounced
 * work the gesture caused (autosave, viewport save) lands. They are reported separately because a
 * 700 ms-late long task after a perfectly smooth drag is still a stall the person feels on the next
 * thing they do, and folding it into the gesture's percentiles would hide both.
 */

import type { Browser, CDPSession, Page } from '@playwright/test';
import type { ScaleManifest } from '../workloads/scale';
import {
  diffMetrics,
  installRecorder,
  readCdpMetrics,
  settle,
  startRecording,
  stopRecording,
  type CdpMetrics,
  type RawRecording,
} from './recorder';
import { formatProfile, saveProfile, startProfile, stopProfile, summarizeProfile } from './profile';
import { SCENARIOS, type Notes, type Scenario, type ScenarioContext } from './scenarios';
import { distribution, frameStats, median, type Distribution, type FrameStats } from './stats';

export const VIEWPORT = { width: 1600, height: 1000 } as const;

export interface LongTaskSummary {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface WindowSummary {
  frames: FrameStats;
  /** From a pointer/wheel event's own timestamp to the first frame that ran after it. */
  inputLatency: Distribution;
  longTasks: LongTaskSummary;
  /** Long Animation Frames: frames whose script + style + layout kept the main thread > 50 ms. */
  loaf: LongTaskSummary & { blockingMs: number; worst: string[] };
  /** Slowest discrete event (click, keydown…) the browser timed, in ms. */
  slowestEventMs: number;
  cdp: CdpMetrics;
}

export interface IterationResult {
  wallMs: number;
  gesture: WindowSummary;
  tail: WindowSummary;
  /** Main-thread task time over the gesture's wall time — how much of every frame was ours. */
  busyPct: number;
  notes: Notes;
  nodesAfter: number;
}

export interface ScenarioSummary {
  scenario: string;
  title: string;
  size: string;
  iterations: IterationResult[];
  /** Medians across iterations of the headline numbers. */
  headline: {
    frameP50: number;
    frameP95: number;
    frameP99: number;
    frameMax: number;
    droppedPct: number;
    hitchPct: number;
    stalls: number;
    latencyP95: number;
    latencyMax: number;
    longTasks: number;
    longTaskTotalMs: number;
    longTaskMaxMs: number;
    busyPct: number;
    scriptMs: number;
    layoutMs: number;
    styleMs: number;
    tailLongTasks: number;
    tailLongTaskMaxMs: number;
    tailMaxFrameMs: number;
    tailTaskMs: number;
    slowestEventMs: number;
  };
  /** Anything that went wrong on the page while it ran. A clean run has none. */
  problems: string[];
  canvasBroken: boolean;
}

function summarizeWindow(raw: RawRecording, cdp: CdpMetrics): WindowSummary {
  const longTasks = raw.longTasks.map(([, duration]) => duration);
  const loafDurations = raw.loaf.map((entry) => entry.duration);
  const worst = [...raw.loaf]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
    .map((entry) => {
      const script = [...entry.scripts].sort((a, b) => b.duration - a.duration)[0];
      return `${entry.duration.toFixed(0)}ms${script ? ` (${script.name || 'script'} ${script.duration.toFixed(0)}ms)` : ''}`;
    });
  return {
    frames: frameStats(raw.frames),
    inputLatency: distribution(raw.latency),
    longTasks: {
      count: longTasks.length,
      totalMs: longTasks.reduce((total, value) => total + value, 0),
      maxMs: longTasks.length === 0 ? 0 : Math.max(...longTasks),
    },
    loaf: {
      count: loafDurations.length,
      totalMs: loafDurations.reduce((total, value) => total + value, 0),
      maxMs: loafDurations.length === 0 ? 0 : Math.max(...loafDurations),
      blockingMs: raw.loaf.reduce((total, entry) => total + entry.blocking, 0),
      worst,
    },
    slowestEventMs: raw.events.length === 0 ? 0 : Math.max(...raw.events.map(([, duration]) => duration)),
    cdp,
  };
}

/** Opens the fixture in a fresh page with the recorder installed, returning it ready to gesture on. */
export async function openFixture(
  browser: Browser,
  baseUrl: string,
  fixture: Buffer,
  manifest: ScaleManifest,
): Promise<{ page: Page; cdp: CDPSession; problems: string[]; area: ScenarioContext['area'] }> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text().slice(0, 200)}`);
  });
  await installRecorder(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');

  await page.goto(`${baseUrl}/?bench=1`);
  await page.setInputFiles('input[type="file"]', {
    name: `${manifest.spec.name}.draftcanvas`,
    mimeType: 'application/json',
    buffer: fixture,
  });
  await page.waitForFunction((n) => document.querySelectorAll('.dc-node').length >= n, manifest.nodes, {
    timeout: 60_000,
  });
  await settle(page, 6);
  // Give lazy chunks, the thumbnail write and the first autosave time to finish before measuring.
  await page.waitForTimeout(1500);

  const box = await page.locator('.react-flow').first().boundingBox();
  if (!box) throw new Error('The canvas has no box.');
  // Clear of the create rail, top bar, status bar and the corner controls.
  const area = { x: box.x + 130, y: box.y + 110, width: box.width - 260, height: box.height - 200 };
  return { page, cdp, problems, area };
}

export async function runScenario(
  browser: Browser,
  baseUrl: string,
  fixture: Buffer,
  manifest: ScaleManifest,
  scenario: Scenario,
  iterations: number,
  warmup: number,
  /** When set, the first measured iteration runs under the CPU profiler and its summary is printed
   *  and saved here. That iteration's timings carry the profiler's overhead, so profile separately. */
  profileDir?: string,
): Promise<ScenarioSummary> {
  const { page, cdp, problems, area } = await openFixture(browser, baseUrl, fixture, manifest);
  const context: ScenarioContext = { page, area, looseNoteIds: manifest.looseNoteIds };
  const results: IterationResult[] = [];
  let canvasBroken = false;

  try {
    for (let run = 0; run < warmup + iterations; run += 1) {
      const prepared = (await scenario.prepare?.(context)) ?? {};
      await settle(page, 3);

      const profiling = profileDir !== undefined && run === warmup;
      if (profiling) await startProfile(cdp);
      const before = await readCdpMetrics(cdp);
      await startRecording(page);
      const t0 = Date.now();
      const notes = await scenario.run(context, prepared);
      const wallMs = Date.now() - t0;
      // A commit's stall begins as the last input is handled. Two frames of grace keep the frame that
      // follows it *inside* the window: without them, whether the stall showed up as one long frame or
      // not at all came down to whether the stop message or the next animation frame reached the page
      // first — the same stall appeared in one run and vanished from the next.
      await settle(page, 2);
      const gestureRaw = await stopRecording(page);
      const afterGesture = await readCdpMetrics(cdp);

      await startRecording(page);
      await page.waitForTimeout(scenario.tailMs);
      const tailRaw = await stopRecording(page);
      const afterTail = await readCdpMetrics(cdp);
      if (profiling && profileDir) {
        const profile = await stopProfile(cdp);
        const name = `${manifest.spec.name}-${scenario.id}`;
        saveProfile(profileDir, name, profile);
        console.log(`\n${formatProfile(name, summarizeProfile(profile, 40), 40)}\n`);
      }

      const nodesAfter = await page.locator('.dc-node').count();
      // A gesture may legitimately fold a shape away (dropping a Note on a connector attaches it),
      // so a couple missing is fine; a canvas that took a render error down shows almost nothing.
      if (nodesAfter < manifest.nodes * 0.9) canvasBroken = true;

      if (run >= warmup) {
        const gestureCdp = diffMetrics(before, afterGesture);
        results.push({
          wallMs,
          gesture: summarizeWindow(gestureRaw, gestureCdp),
          tail: summarizeWindow(tailRaw, diffMetrics(afterGesture, afterTail)),
          busyPct: wallMs === 0 ? 0 : (gestureCdp.taskMs / wallMs) * 100,
          notes,
          nodesAfter,
        });
      }

      if (canvasBroken) break;
      await scenario.restore?.(context);
      await settle(page, 4);
    }
  } finally {
    await page.context().close();
  }

  const pick = (read: (result: IterationResult) => number) => median(results.map(read));
  return {
    scenario: scenario.id,
    title: scenario.title,
    size: manifest.spec.name,
    iterations: results,
    headline: {
      frameP50: pick((r) => r.gesture.frames.p50),
      frameP95: pick((r) => r.gesture.frames.p95),
      frameP99: pick((r) => r.gesture.frames.p99),
      frameMax: pick((r) => r.gesture.frames.max),
      droppedPct: pick((r) => r.gesture.frames.droppedPct),
      hitchPct: pick((r) => r.gesture.frames.hitchPct),
      stalls: pick((r) => r.gesture.frames.stalls),
      latencyP95: pick((r) => r.gesture.inputLatency.p95),
      latencyMax: pick((r) => r.gesture.inputLatency.max),
      longTasks: pick((r) => r.gesture.longTasks.count),
      longTaskTotalMs: pick((r) => r.gesture.longTasks.totalMs),
      longTaskMaxMs: pick((r) => r.gesture.longTasks.maxMs),
      busyPct: pick((r) => r.busyPct),
      scriptMs: pick((r) => r.gesture.cdp.scriptMs),
      layoutMs: pick((r) => r.gesture.cdp.layoutMs),
      styleMs: pick((r) => r.gesture.cdp.styleMs),
      tailLongTasks: pick((r) => r.tail.longTasks.count),
      tailLongTaskMaxMs: pick((r) => r.tail.longTasks.maxMs),
      tailMaxFrameMs: pick((r) => r.tail.frames.max),
      tailTaskMs: pick((r) => r.tail.cdp.taskMs),
      slowestEventMs: pick((r) => Math.max(r.gesture.slowestEventMs, r.tail.slowestEventMs)),
    },
    problems: [...new Set(problems)].slice(0, 6),
    canvasBroken,
  };
}

export function scenarioById(id: string): Scenario {
  const found = SCENARIOS.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`Unknown scenario "${id}". Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  return found;
}
