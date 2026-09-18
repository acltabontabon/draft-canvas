/**
 * The parts of working in Draft Canvas that are not a gesture: opening a diagram, exporting it,
 * finding it among a hundred others, and doing the same things over and over for a long session.
 *
 * Memory is judged by *slope*, never by a snapshot. A single reading cannot tell a cache that has
 * filled from an object graph that keeps growing, so the soak samples after every cycle (with a
 * forced GC first), drops the warmup, and fits a line through what is left: a plateau has a slope
 * near zero, a retained graph keeps climbing.
 */

import type { Browser, CDPSession, Page } from '@playwright/test';
import { buildScaleDocument, SCALE_SPECS, type ScaleManifest, type ScaleName } from '../workloads/scale';
import { forceGC } from '../browser';
import {
  installRecorder,
  nextFrame,
  readCdpMetrics,
  settle,
  startRecording,
  stopRecording,
  type CdpMetrics,
  type RawRecording,
} from './recorder';
import { openFixture, VIEWPORT } from './run';
import { median, slope } from './stats';

const longest = (raw: RawRecording) => Math.max(0, ...raw.longTasks.map(([, duration]) => duration));

export interface LoadResult {
  size: string;
  /** From choosing the file to every shape being on screen and two idle frames having passed. */
  loadMs: number;
  longestTaskMs: number;
  heapMiB: number;
  domNodes: number;
  listeners: number;
}

/** A cold load each iteration: a fresh page, so lazy chunks and caches start from nothing. */
export async function measureLoad(
  browser: Browser,
  baseUrl: string,
  fixture: Buffer,
  manifest: ScaleManifest,
  iterations: number,
): Promise<LoadResult> {
  const timings: number[] = [];
  const tasks: number[] = [];
  let metrics: CdpMetrics | undefined;
  for (let i = 0; i < iterations + 1; i += 1) {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await installRecorder(page);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    await page.goto(`${baseUrl}/?bench=1`);
    await settle(page, 3);
    await startRecording(page);
    const t0 = Date.now();
    await page.setInputFiles('input[type="file"]', {
      name: `${manifest.spec.name}.draftcanvas`,
      mimeType: 'application/json',
      buffer: fixture,
    });
    await page.waitForFunction((n) => document.querySelectorAll('.dc-node').length >= n, manifest.nodes, {
      timeout: 60_000,
    });
    await settle(page, 2);
    const elapsed = Date.now() - t0;
    const raw = await stopRecording(page);
    await forceGC(cdp);
    const after = await readCdpMetrics(cdp);
    // The first iteration is a warmup (module compilation, the service worker's first pass).
    if (i > 0) {
      timings.push(elapsed);
      tasks.push(longest(raw));
      metrics = after;
    }
    await context.close();
  }
  return {
    size: manifest.spec.name,
    loadMs: median(timings),
    longestTaskMs: median(tasks),
    heapMiB: metrics?.heapMiB ?? 0,
    domNodes: metrics?.domNodes ?? 0,
    listeners: metrics?.listeners ?? 0,
  };
}

export interface ExportResult {
  kind: 'svg' | 'png';
  ms: number;
  longestTaskMs: number;
  bytes: number;
}

/** Export through the real dialog, timing from the click to the browser receiving the file. */
export async function measureExport(page: Page, kind: 'svg' | 'png'): Promise<ExportResult> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.locator('[data-mode="image"]').click();
  // The dialog remembers the last format, so name the one wanted rather than trusting the default.
  await dialog.locator(`[data-value="${kind}"]`).click();
  await startRecording(page);
  const t0 = Date.now();
  // Waited for together with the click: a wait started on its own and left dangling by a failed click
  // rejects later, unhandled, when the page goes away — and takes the whole run down with it.
  const [file] = await Promise.all([
    page.waitForEvent('download', { timeout: 120_000 }),
    page.getByRole('button', { name: kind === 'svg' ? 'Export SVG' : 'Export PNG' }).click(),
  ]);
  const ms = Date.now() - t0;
  const raw = await stopRecording(page);
  const path = await file.path();
  const { size } = await import('node:fs').then((fs) => fs.statSync(path));
  await page.keyboard.press('Escape');
  return { kind, ms, longestTaskMs: longest(raw), bytes: size };
}

export interface LibraryResult {
  diagrams: number;
  /** From the page starting to load to every row being on screen. */
  readyMs: number;
  longestTaskMs: number;
  rows: number;
}

/**
 * Seeds `count` diagrams (the Small fixture under different ids), then reloads and times how long
 * the Library takes to show them all — the row summaries, their fingerprints and the startup
 * backfill are what is on trial.
 */
export async function measureLibrary(browser: Browser, baseUrl: string, count: number): Promise<LibraryResult> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const { document: seed } = buildScaleDocument(SCALE_SPECS.small);
  await installRecorder(page);
  await page.goto(`${baseUrl}/?bench=1`);
  for (let i = 0; i < count; i += 1) {
    const copy = { ...seed, metadata: { ...seed.metadata, id: `bench-lib-${i}`, title: `Diagram ${i + 1}` } };
    await page.setInputFiles('input[type="file"]', {
      name: `diagram-${i}.draftcanvas`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(copy)),
    });
    await page.locator('.dc-editor').first().waitFor();
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await page.locator('.dc-library-item').first().waitFor();
  }

  // A fresh navigation: everything the Library does on the way in is inside the window.
  const t0 = Date.now();
  await page.goto(`${baseUrl}/?bench=1&again=${Date.now()}`);
  await page.waitForFunction((n) => document.querySelectorAll('.dc-library-item').length >= n, count, {
    timeout: 60_000,
  });
  await settle(page, 2);
  const readyMs = Date.now() - t0;
  // The observers need a moment: the recorder starts with the page, the window is the whole load.
  await startRecording(page);
  await nextFrame(page);
  const raw = await stopRecording(page);
  const rows = await page.locator('.dc-library-item').count();
  await context.close();
  return { diagrams: count, readyMs, longestTaskMs: longest(raw), rows };
}

export interface SoakSample {
  cycle: number;
  heapMiB: number;
  domNodes: number;
  listeners: number;
}

export interface SoakResult {
  label: string;
  cycles: number;
  warmup: number;
  samples: SoakSample[];
  /** Least-squares growth per cycle once the warmup is dropped, and the fitted change across it. */
  heap: { perCycleMiB: number; totalMiB: number; r2: number };
  domNodes: { perCycle: number; total: number };
  listeners: { perCycle: number; total: number };
}

function summarizeSoak(label: string, samples: SoakSample[], warmup: number): SoakResult {
  const tail = samples.slice(warmup);
  const heap = slope(tail.map((s) => s.heapMiB));
  const nodes = slope(tail.map((s) => s.domNodes));
  const listeners = slope(tail.map((s) => s.listeners));
  return {
    label,
    cycles: samples.length,
    warmup,
    samples,
    heap: { perCycleMiB: heap.perStep, totalMiB: heap.total, r2: heap.r2 },
    domNodes: { perCycle: nodes.perStep, total: nodes.total },
    listeners: { perCycle: listeners.perStep, total: listeners.total },
  };
}

async function sample(cdp: CDPSession, cycle: number): Promise<SoakSample> {
  await forceGC(cdp);
  await forceGC(cdp);
  const { heapMiB, domNodes, listeners } = await readCdpMetrics(cdp);
  return { cycle, heapMiB, domNodes, listeners };
}

/**
 * Open a diagram, edit it, leave it, open another — `cycles` times — sampling after each. A canvas
 * that leaked a listener, an observer or a retained document per open would show as a slope here.
 */
// A note on how these soaks wait: `page.waitForSelector` hands back an `ElementHandle`, and a handle a
// script drops without disposing keeps that element alive in the page for as long as the page lives. A
// soak that opens and closes a canvas 25 times through it holds 25 dead editors and reports a "leak"
// that is entirely the measuring — a heap snapshot showed every retainer as the client's own handle. So
// nothing here waits on a selector; `locator.waitFor()` returns nothing to hold.
export async function soakSwitching(
  browser: Browser,
  baseUrl: string,
  size: ScaleName,
  cycles: number,
  warmup: number,
): Promise<SoakResult> {
  const { document: seed, manifest } = buildScaleDocument(SCALE_SPECS[size]);
  const { page, cdp } = await openFixture(browser, baseUrl, Buffer.from(JSON.stringify(seed)), manifest);
  // A second diagram to switch to, so every cycle really unmounts one canvas and mounts another.
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  const other = { ...seed, metadata: { ...seed.metadata, id: 'bench-other', title: 'Other diagram' } };
  await page.setInputFiles('input[type="file"]', {
    name: 'other.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(other)),
  });
  await page.locator('.dc-editor').first().waitFor();

  const samples: SoakSample[] = [];
  const titles = ['Other diagram', `Benchmark — ${manifest.spec.label}`];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    // Some real editing in this canvas first: a rename and an undo, which touch history, autosave
    // and the crossing/routing caches.
    const node = page.locator('.react-flow__node').filter({ has: page.locator('.dc-node:not([data-type="group"])') }).first();
    await node.click({ position: { x: 10, y: 10 }, force: true });
    await page.keyboard.press('Enter');
    await page.keyboard.type(`Edit ${cycle}`);
    await page.locator('.react-flow__pane').click({ position: { x: 30, y: 30 }, force: true });
    await page.keyboard.press('ControlOrMeta+z');
    await settle(page, 4);

    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await page.locator('.dc-library-item', { hasText: titles[cycle % 2]! }).first().click();
    await page.locator('.dc-editor').first().waitFor();
    await page.waitForFunction((n) => document.querySelectorAll('.dc-node').length >= n, 1);
    await settle(page, 4);
    samples.push(await sample(cdp, cycle));
  }
  await page.context().close();
  return summarizeSoak(`switch × ${cycles} (${size})`, samples, warmup);
}

/**
 * Drag a shape out and back `cycles` times on one canvas. History keeps a snapshot per step and the
 * derived caches (routing plan, crossing plan, obstacle grids) are keyed by the arrays those
 * snapshots hold — this is what shows whether they are released once history lets go.
 */
export async function soakEditing(
  browser: Browser,
  baseUrl: string,
  size: ScaleName,
  cycles: number,
  warmup: number,
): Promise<SoakResult> {
  const { document: seed, manifest } = buildScaleDocument(SCALE_SPECS[size]);
  const { page, cdp } = await openFixture(browser, baseUrl, Buffer.from(JSON.stringify(seed)), manifest);
  const box = await page
    .locator('.react-flow__node')
    .filter({ has: page.locator('.dc-node:not([data-type="group"])') })
    .nth(3)
    .boundingBox();
  if (!box) throw new Error('No shape to drag.');
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // Out and back by the same delta, so the shape never wanders and every cycle is two committed
  // edits: history fills to its limit part-way through and is then trimmed on every step, which is
  // exactly the regime a long session lives in.
  const drag = async (dx: number, dy: number, at: { x: number; y: number }) => {
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(at.x + (dx * step) / 10, at.y + (dy * step) / 10);
      await nextFrame(page);
    }
    await page.mouse.up();
    await settle(page, 2);
  };
  const samples: SoakSample[] = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await drag(96, 48, from);
    await drag(-96, -48, { x: from.x + 96, y: from.y + 48 });
    samples.push(await sample(cdp, cycle));
  }
  await page.context().close();
  return summarizeSoak(`drag out and back × ${cycles} (${size})`, samples, warmup);
}
