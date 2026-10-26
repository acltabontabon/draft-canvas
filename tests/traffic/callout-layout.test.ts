import { describe, expect, it } from 'vitest';
import { placeCallout } from '../../src/traffic/calloutLayout';
import type { Rect } from '../../src/traffic/sketchLayout';

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe('traffic callout placement', () => {
  const anchor = { x: 0, y: 0, width: 180, height: 84 };

  it('keeps the preferred right side when clear', () => {
    expect(placeCallout(anchor, 300, 100, [])).toEqual({ x: 206, y: -6, width: 300, height: 100 });
  });

  it('avoids findings already written beside the selected shape', () => {
    const note = { x: 220, y: -20, width: 210, height: 60 };
    const result = placeCallout(anchor, 300, 100, [note]);
    expect(result.x).toBeLessThan(anchor.x);
    expect(overlaps(result, note)).toBe(false);
    expect(overlaps(result, anchor)).toBe(false);
  });

  it('accounts for the full height of wrapped explanations', () => {
    const lowerShape = { x: 210, y: 90, width: 180, height: 84 };
    expect(placeCallout(anchor, 300, 60, [lowerShape]).x).toBe(206);
    const tall = placeCallout(anchor, 300, 220, [lowerShape]);
    expect(tall.x).toBeLessThan(0);
    expect(overlaps(tall, lowerShape)).toBe(false);
  });

  it('finds clear space even when every nearby side is crowded', () => {
    const crowded = { x: -1000, y: -1000, width: 2000, height: 2000 };
    const result = placeCallout(anchor, 300, 220, [crowded]);
    expect(overlaps(result, crowded)).toBe(false);
    expect(overlaps(result, anchor)).toBe(false);
  });

  it('keeps a tall note visible near the bottom of the canvas', () => {
    const visible = { x: -100, y: -100, width: 900, height: 500 };
    const nearBottom = { ...anchor, y: 280 };
    const result = placeCallout(nearBottom, 300, 306, [], visible);
    expect(result.y).toBeGreaterThanOrEqual(visible.y);
    expect(result.y + result.height).toBeLessThanOrEqual(visible.y + visible.height);
    expect(overlaps(result, nearBottom)).toBe(false);
  });

  it('stays on the canvas when clear nearby sides are off-screen', () => {
    const visible = { x: 0, y: 0, width: 620, height: 480 };
    const crowded = { x: 0, y: 0, width: 310, height: 480 };
    const result = placeCallout(anchor, 300, 300, [crowded], visible);
    expect(result.x).toBeGreaterThanOrEqual(310);
    expect(result.x + result.width).toBeLessThanOrEqual(visible.width);
    expect(result.y + result.height).toBeLessThanOrEqual(visible.height);
  });
});
