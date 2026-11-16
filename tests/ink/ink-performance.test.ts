import { describe, expect, it } from 'vitest';
import { addInk, translateInk } from '../../src/document/ink';
import { createDocument } from '../../src/document/factory';
import { LIMITS } from '../../src/document/limits';
import type { DraftInk } from '../../src/document/types';
import { inkPaint } from '../../src/render/ink';
import { renderDocumentSvg } from '../../src/render/svg/document';
import { diffFile } from '../../src/collab/diff';

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
