/**
 * What the page records about itself while a scenario runs, and the Node-side helpers that read it
 * back. Frame times come from `requestAnimationFrame` deltas, input latency from pointer events'
 * own timestamps against the frame that first ran after them, and the browser's Long Task, Long
 * Animation Frame and Event Timing observers cover what a delta cannot say — *what* was slow.
 *
 * The recorder is a plain string, not a function passed to `addInitScript`: `tsx` compiles with
 * `keepNames`, which wraps named functions in a `__name(...)` helper that does not exist inside the
 * page. Shipping source text sidesteps that entirely (and `__name` is stubbed below for the
 * `page.evaluate` callbacks the scenarios still use).
 */

import type { CDPSession, Page } from '@playwright/test';

export const RECORDER_SOURCE = `
(() => {
  if (window.__bench) return;
  window.__name = (fn) => fn;
  const state = {
    on: false,
    lastFrame: 0,
    frames: [],
    pending: [],
    latency: [],
    longTasks: [],
    loaf: [],
    events: [],
  };

  const onPointer = (event) => {
    if (state.on) state.pending.push(event.timeStamp);
  };
  window.addEventListener('pointermove', onPointer, { capture: true, passive: true });
  window.addEventListener('wheel', onPointer, { capture: true, passive: true });

  const tick = (now) => {
    if (state.on) {
      if (state.lastFrame) state.frames.push(now - state.lastFrame);
      for (const stamp of state.pending) state.latency.push(now - stamp);
      state.pending.length = 0;
    }
    state.lastFrame = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const observe = (type, options, sink) => {
    try {
      new PerformanceObserver((list) => {
        if (!state.on) return;
        for (const entry of list.getEntries()) sink(entry);
      }).observe({ type, ...options });
    } catch (error) {
      // An observer type this Chromium does not know is reported by absence, not by throwing.
    }
  };
  observe('longtask', {}, (e) => state.longTasks.push([e.startTime, e.duration]));
  observe('long-animation-frame', {}, (e) =>
    state.loaf.push({
      start: e.startTime,
      duration: e.duration,
      blocking: e.blockingDuration,
      renderStart: e.renderStart,
      styleAndLayoutStart: e.styleAndLayoutStart,
      scripts: (e.scripts || []).slice(0, 4).map((s) => ({
        name: s.sourceFunctionName || s.invoker || '',
        duration: s.duration,
      })),
    }),
  );
  observe('event', { durationThreshold: 16 }, (e) => state.events.push([e.name, e.duration, e.processingEnd - e.processingStart]));

  window.__bench = {
    start() {
      state.frames = [];
      state.pending = [];
      state.latency = [];
      state.longTasks = [];
      state.loaf = [];
      state.events = [];
      state.lastFrame = 0;
      state.on = true;
    },
    stop() {
      state.on = false;
      return {
        frames: state.frames,
        latency: state.latency,
        longTasks: state.longTasks,
        loaf: state.loaf,
        events: state.events,
      };
    },
  };
})();
`;

export interface RawRecording {
  frames: number[];
  latency: number[];
  longTasks: Array<[start: number, duration: number]>;
  loaf: Array<{
    start: number;
    duration: number;
    blocking: number;
    renderStart: number;
    styleAndLayoutStart: number;
    scripts: Array<{ name: string; duration: number }>;
  }>;
  events: Array<[name: string, duration: number, processing: number]>;
}

export async function installRecorder(page: Page): Promise<void> {
  await page.context().addInitScript({ content: RECORDER_SOURCE });
}

export async function startRecording(page: Page): Promise<void> {
  await page.evaluate('window.__bench.start()');
}

export async function stopRecording(page: Page): Promise<RawRecording> {
  return (await page.evaluate('window.__bench.stop()')) as RawRecording;
}

/** One animation frame, i.e. the pace a 60 Hz person would move a pointer at. */
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => resolve()))');
}

/** Waits for the main thread to go quiet: two frames with nothing between them worth measuring. */
export async function settle(page: Page, frames = 3): Promise<void> {
  for (let i = 0; i < frames; i += 1) await nextFrame(page);
}

export interface CdpMetrics {
  taskMs: number;
  scriptMs: number;
  layoutMs: number;
  styleMs: number;
  layoutCount: number;
  styleCount: number;
  heapMiB: number;
  domNodes: number;
  listeners: number;
}

export async function readCdpMetrics(cdp: CDPSession): Promise<CdpMetrics> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
  return {
    taskMs: get('TaskDuration') * 1000,
    scriptMs: get('ScriptDuration') * 1000,
    layoutMs: get('LayoutDuration') * 1000,
    styleMs: get('RecalcStyleDuration') * 1000,
    layoutCount: get('LayoutCount'),
    styleCount: get('RecalcStyleCount'),
    heapMiB: get('JSHeapUsedSize') / (1024 * 1024),
    domNodes: get('Nodes'),
    listeners: get('JSEventListeners'),
  };
}

export function diffMetrics(before: CdpMetrics, after: CdpMetrics): CdpMetrics {
  return {
    taskMs: after.taskMs - before.taskMs,
    scriptMs: after.scriptMs - before.scriptMs,
    layoutMs: after.layoutMs - before.layoutMs,
    styleMs: after.styleMs - before.styleMs,
    layoutCount: after.layoutCount - before.layoutCount,
    styleCount: after.styleCount - before.styleCount,
    heapMiB: after.heapMiB,
    domNodes: after.domNodes,
    listeners: after.listeners,
  };
}
