import { describe, expect, it } from 'vitest';
import { addInk, inkAbsolutePoints, inkRound, translateInk } from '../../src/document/ink';
import { createDocument } from '../../src/document/factory';
import { LIMITS } from '../../src/document/limits';
import type { DraftInk } from '../../src/document/types';
import { buildStroke, simplifyIndices, type InkSample } from '../../src/ink/capture';
import { recognize } from '../../src/ink/recognize';
import { inkPaint } from '../../src/render/ink';
import { renderDocumentSvg } from '../../src/render/svg/document';
import { diffFile } from '../../src/collab/diff';
import { rng } from './corpus';

/** A canvas at the stroke limit, each stroke a hand-length scribble of 120 points. */
function crowded(): DraftInk[] {
  return Array.from({ length: LIMITS.maxInkStrokes }, (_, i) => ({
    id: `k${i}`,
    tool: i % 5 === 0 ? 'highlighter' : 'pen',
    color: 'blue',
    size: i % 5 === 0 ? 20 : 3,
    x: (i % 80) * 40,
    y: Math.floor(i / 80) * 40,
    points: Array.from({ length: 240 }, (_, k) => (k % 2 === 0 ? k * 0.4 : Math.sin(k / 9) * 12)),
    ...(i % 3 === 0 ? { pressure: Array.from({ length: 120 }, (_, k) => 30 + (k % 50)) } : {}),
  }));
}

describe('a canvas full of sketches', () => {
  it('paints every stroke quickly, and repaints from cache', () => {
    const strokes = crowded();
    let start = performance.now();
    for (const stroke of strokes) inkPaint(stroke, 'dark');
    const first = performance.now() - start;
    start = performance.now();
    for (const stroke of strokes) inkPaint(stroke, 'dark');
    const again = performance.now() - start;
    expect(first).toBeLessThan(1500);
    expect(again).toBeLessThan(first);
  });

  it('moving one stroke is a one-element change, however many there are', () => {
    const doc = addInk(createDocument(), crowded());
    const start = performance.now();
    const moved = translateInk(doc, ['k17'], 4, 4);
    const changes = diffFile(doc, moved);
    expect(performance.now() - start).toBeLessThan(200);
    expect(changes).toHaveLength(1);
  });

  it('exports a crowded canvas', () => {
    const doc = addInk(createDocument(), crowded().slice(0, 1000));
    const start = performance.now();
    const { svg } = renderDocumentSvg(doc);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(svg.length).toBeGreaterThan(100_000);
  });
});

/** A hand going back and forth inside 600 × 400 for as long as asked, one sample every ~3 units. */
function scribble(count: number, seed = 1, spread = 1): InkSample[] {
  const random = rng(seed);
  const out: InkSample[] = [];
  let x = 300;
  let y = 200;
  let heading = 0;
  for (let i = 0; i < count; i += 1) {
    heading += (random() - 0.5) * 0.6;
    x += Math.cos(heading) * 3;
    y += Math.sin(heading) * 3;
    if (x < 0 || x > 600) heading = Math.PI - heading;
    if (y < 0 || y > 400) heading = -heading;
    out.push({ x: x * spread, y: y * spread, pressure: 0.3 + 0.4 * random() });
  }
  return out;
}

const pen = { tool: 'pen', color: 'graphite', size: 3 } as const;

/*
 * Smart Ink reads a drawing in screen pixels, resampled every few of them, and finding where a
 * one-stroke outline closes compares the start of the stroke with its end, point by point. A
 * stroke long on screen (scribbled for minutes, or read zoomed in) took time with the square of
 * its length: 19 s for 100,000 points, and 56 s for "Convert to shape" on a stored stroke at zoom 4.
 */
describe('a long stroke', () => {
  it('is read in bounded time, however long it is on screen', () => {
    const stroke = scribble(100_000);
    const started = performance.now();
    const reading = recognize([stroke], { scale: 1 });
    expect(performance.now() - started).toBeLessThan(500);
    expect(reading.confidence).toBeLessThan(0.38);
  });

  it('is converted later at any zoom in bounded time', () => {
    // Drawn zoomed out (0.1) and thinned to the file's limit, then read with "Convert to shape"
    // zoomed in four times further than 1.
    const stored = buildStroke(scribble(4_000, 3, 10), pen, { zoom: 0.1, pressure: false })!;
    expect(stored.points.length / 2).toBeGreaterThan(1_000);
    const points = inkAbsolutePoints(stored);
    for (const scale of [1, 4]) {
      const started = performance.now();
      recognize([points], { scale });
      expect(performance.now() - started, `at zoom ${scale}`).toBeLessThan(500);
    }
  });

  it('is kept at pen-up in bounded time, and exactly as simplifying again for each epsilon kept it', () => {
    // What `buildStroke` used to do: simplify the whole stroke again at every larger epsilon, then
    // keep each point as a rounded offset from the first. (These samples are 3 apart, so none is
    // dropped as a repeat first.)
    const again = (samples: readonly InkSample[], zoom: number) => {
      let epsilon = 0.33 / zoom;
      let kept = simplifyIndices(samples, epsilon);
      while (kept.length > LIMITS.maxInkPoints) {
        epsilon *= 1.6;
        kept = simplifyIndices(samples, epsilon);
      }
      const origin = { x: inkRound(samples[0]!.x), y: inkRound(samples[0]!.y) };
      return kept.flatMap((index) => [inkRound(samples[index]!.x - origin.x), inkRound(samples[index]!.y - origin.y)]);
    };
    for (const [count, zoom] of [[3_000, 1], [12_000, 0.5], [20_000, 2]] as const) {
      const samples = scribble(count, count);
      expect(buildStroke(samples, pen, { zoom, pressure: true })!.points, `${count} samples`).toEqual(again(samples, zoom));
    }
    // A spiral of 100,000 samples, minutes of drawing: 17.8 s here before, one simplification now.
    const spiral = Array.from({ length: 100_000 }, (_, i) => ({ x: Math.cos(i / 40) * (200 + i / 50) + i * 0.05, y: Math.sin(i / 40) * (200 + i / 50), pressure: 0.5 }));
    const started = performance.now();
    const kept = buildStroke(spiral, pen, { zoom: 1, pressure: false })!;
    expect(performance.now() - started).toBeLessThan(6_000);
    expect(kept.points.length / 2).toBeLessThanOrEqual(LIMITS.maxInkPoints);
  }, 60_000);
});
