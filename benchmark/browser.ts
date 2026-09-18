/**
 * Chromium launch + CDP session helpers. `Performance.getMetrics` gives precise, attributable JS
 * heap/DOM/listener counts; `HeapProfiler.collectGarbage` forces a GC pass before a before/after
 * comparison so a sample isn't just "whatever hadn't been collected yet."
 */

import { chromium, type Browser, type CDPSession, type Page } from '@playwright/test';

export interface LaunchOptions {
  /** A visible window: the closest thing to what a person sees, at the cost of taking over a screen. */
  headed?: boolean;
  /**
   * Lift Chromium's frame-rate cap (`--disable-frame-rate-limit`). Off by default, because on an
   * unthrottled machine it nudges the idle cadence (17.3 ms instead of 16.7) and would make a run
   * differ from every earlier one; on a laptop below ~20% battery, where Chromium caps to 30 Hz, it is
   * the difference between measuring the app and measuring the power state. `measureFrameFloor`
   * says which of the two a run was on.
   */
  uncapFrames?: boolean;
  /**
   * Chromium's current headless mode (`channel: 'chromium'`) shares the full browser's rendering
   * path, where the default headless *shell* is a separate, slimmer build. Frame timings from the
   * former are the more honest ones; the load/heap/drag benchmark keeps the shell so its baseline
   * stays comparable.
   */
  newHeadless?: boolean;
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const args = options.uncapFrames ? [...BACKGROUND_FLAGS, UNCAP_FLAG] : BACKGROUND_FLAGS;
  if (options.headed) return chromium.launch({ headless: false, args });
  if (options.newHeadless) return chromium.launch({ channel: 'chromium', headless: true, args });
  return chromium.launch({ headless: true });
}

/** A window nobody is looking at is a window Chromium is entitled to throttle; a benchmark must not be. */
const BACKGROUND_FLAGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

/** In any energy-saving state — a laptop below ~20% battery, say — Chromium caps rendering at 30
 *  frames a second, so an idle page ticks every 33 ms and every gesture "misses" 60 Hz through no
 *  fault of the app. This lifts the cap. See `LaunchOptions.uncapFrames`. */
const UNCAP_FLAG = '--disable-frame-rate-limit';

/**
 * How fast an *idle* page ticks here, in ms per frame (16.7 = 60 Hz). The floor every frame time in a
 * result has to be read against: a run measured while the machine was throttled to 30 Hz has a floor
 * of 33.3, and its numbers say nothing about the app until compared with another run at the same one.
 */
export async function measureFrameFloor(browser: Browser): Promise<number> {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const p50 = (await page.evaluate(
    `new Promise((resolve) => {
      const times = [];
      let last = 0;
      const tick = (now) => {
        if (last) times.push(now - last);
        last = now;
        if (times.length < 90) requestAnimationFrame(tick);
        else { times.sort((a, b) => a - b); resolve(times[Math.floor(times.length / 2)]); }
      };
      requestAnimationFrame(tick);
    })`,
  )) as number;
  await page.close();
  return p50;
}

export async function openCdpPage(browser: Browser): Promise<{ page: Page; cdp: CDPSession }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  return { page, cdp };
}

export async function readHeapMetrics(
  cdp: CDPSession,
): Promise<{ jsHeapUsedMiB: number; domNodes: number; jsEventListeners: number }> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const find = (name: string) => metrics.find((entry) => entry.name === name)?.value ?? 0;
  return {
    jsHeapUsedMiB: find('JSHeapUsedSize') / (1024 * 1024),
    domNodes: find('Nodes'),
    jsEventListeners: find('JSEventListeners'),
  };
}

export async function forceGC(cdp: CDPSession): Promise<void> {
  await cdp.send('HeapProfiler.collectGarbage');
}
