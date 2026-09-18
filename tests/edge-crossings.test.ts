import { describe, expect, it } from 'vitest';
import { BRIDGE_RADIUS, BRIDGE_RISE, bridgePath } from '../src/edges/bridge';
import type { Crossing } from '../src/edges/crossings';
import { flattenPath } from '../src/edges/routing';

const UP = { nx: 0, ny: -1 };

function at(x: number, y: number, bow = UP): Crossing {
  return { x, y, nx: bow.nx, ny: bow.ny, otherSource: 'other-a', otherTarget: 'other-b' };
}

/** The drawn path's endpoints — a bridge must never move where a connector attaches. */
function ends(d: string) {
  const points = flattenPath(d);
  return [points[0], points[points.length - 1]];
}

/** How far the path rises above `y` somewhere near `x` — the hump's own height. */
function riseNear(d: string, x: number, y: number): number {
  const points = flattenPath(d);
  let rise = 0;
  for (const point of points) {
    if (Math.abs(point.x - x) > BRIDGE_RADIUS * 2) continue;
    rise = Math.max(rise, y - point.y);
  }
  return rise;
}

/** A hump is drawn as two cubics — one easing up to the apex, one easing back down — so that its
 *  shoulders meet the line travelling along it instead of at a right angle. */
const humpCount = (d: string) => (d.match(/C/g) ?? []).length / 2;

/** Most of the hump's height, allowing for the flattened sampling `flattenPath` does. */
const MOST_OF_THE_RISE = BRIDGE_RISE * 0.8;

describe('bridgePath', () => {
  const horizontal = 'M0 50L200 50';

  it('is the identity when nothing crosses', () => {
    expect(bridgePath(horizontal, [])).toBe(horizontal);
  });

  it('arcs over a crossing in the middle of a straight run', () => {
    const bridged = bridgePath(horizontal, [at(100, 50)]);
    expect(bridged).not.toBe(horizontal);
    expect(bridged).toContain('C');
    expect(riseNear(bridged, 100, 50)).toBeGreaterThan(MOST_OF_THE_RISE);
  });

  it('leaves the connector attached exactly where it was', () => {
    const bridged = bridgePath(horizontal, [at(100, 50)]);
    expect(ends(bridged)).toEqual(ends(horizontal));
  });

  it('still parses as a path both renderers understand', () => {
    const bridged = bridgePath(horizontal, [at(100, 50)]);
    expect(flattenPath(bridged).length).toBeGreaterThan(2);
  });

  it('draws one arc per crossing along the same connector', () => {
    const bridged = bridgePath(horizontal, [at(60, 50), at(140, 50)]);
    expect(humpCount(bridged)).toBe(2);
    expect(riseNear(bridged, 60, 50)).toBeGreaterThan(MOST_OF_THE_RISE);
    expect(riseNear(bridged, 140, 50)).toBeGreaterThan(MOST_OF_THE_RISE);
  });

  it('keeps one clean arc where two crossings are closer than its own width', () => {
    const bridged = bridgePath(horizontal, [at(100, 50), at(103, 50)]);
    expect(humpCount(bridged)).toBe(1);
  });

  it('abandons a crossing that no longer lands on the connector', () => {
    expect(bridgePath(horizontal, [at(100, 120)])).toBe(horizontal);
  });

  it('snaps a crossing that has drifted slightly, as roughness and live measurement make it', () => {
    const bridged = bridgePath(horizontal, [at(100, 52.5)]);
    expect(bridged).toContain('C');
  });

  it('refuses a crossing with no room for an arc before the connector ends', () => {
    expect(bridgePath(horizontal, [at(1, 50)])).toBe(horizontal);
    expect(bridgePath(horizontal, [at(199, 50)])).toBe(horizontal);
  });

  it('bows a vertical run sideways, not along itself', () => {
    const vertical = 'M50 0L50 200';
    const bridged = bridgePath(vertical, [at(50, 100, { nx: -1, ny: 0 })]);
    const points = flattenPath(bridged);
    const left = Math.min(...points.map((point) => point.x));
    expect(50 - left).toBeGreaterThan(MOST_OF_THE_RISE);
  });

  it('bridges a bezier connector by splitting the curve', () => {
    const curve = 'M0 50C60 50 140 50 200 50';
    const bridged = bridgePath(curve, [at(100, 50)]);
    expect(bridged).not.toBe(curve);
    expect(riseNear(bridged, 100, 50)).toBeGreaterThan(MOST_OF_THE_RISE);
    expect(ends(bridged)).toEqual(ends(curve));
  });

  it('leaves a rounded corner alone — there is no room there for an arc that reads as one', () => {
    // `stepCorner`'s own shape at the standard 10-unit radius.
    const corner = 'M0 0L90 0Q100 0 100 10L100 100';
    expect(bridgePath(corner, [at(100, 0)])).toBe(corner);
  });

  it('passes through a path it does not recognise', () => {
    const arcPath = 'M0 0A10 10 0 0 1 20 20';
    expect(bridgePath(arcPath, [at(10, 10)])).toBe(arcPath);
  });

  it('reuses the same string for the same connector and crossings', () => {
    const crossings = Object.freeze([at(100, 50)]);
    expect(bridgePath(horizontal, crossings)).toBe(bridgePath(horizontal, crossings));
  });
});
