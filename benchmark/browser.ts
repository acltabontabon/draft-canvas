/**
 * Chromium launch + CDP session helpers. `Performance.getMetrics` gives precise, attributable JS
 * heap/DOM/listener counts; `HeapProfiler.collectGarbage` forces a GC pass before a before/after
 * comparison so a sample isn't just "whatever hadn't been collected yet."
 */

import { chromium, type Browser, type CDPSession, type Page } from '@playwright/test';

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
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
