import { describe, expect, it } from 'vitest';
import { dataStoreGlyphBounds, dataStoreScale } from '../src/document/dataStoreGeometry';
import { createNode } from '../src/document/factory';
import { anchorPoint, rectOf } from '../src/edges/routing';
import { describeContext, describeNode } from '../src/nodes/describe';
import { emitShape } from '../src/render/svg/emit';
import { serialize } from '../src/render/svg/element';
import { LIGHT } from '../src/render/theme/tokens';

/**
 * A Data Store's shape grows with its box. It never shrinks below the size it has always had — the
 * default box and every smaller one keep exactly their look — and a box stretched only one way
 * keeps its glyph, so scaling follows whichever side has grown least.
 */

const ctx = describeContext(LIGHT);
const store = (width: number, height: number, extra = {}) =>
  createNode({ type: 'database', id: 'ds', x: 0, y: 0, width, height, text: 'Orders', ...extra });

describe('dataStoreScale', () => {
  it('is 1 at the default box and at every smaller one', () => {
    expect(dataStoreScale({ width: 148, height: 88 })).toBe(1);
    expect(dataStoreScale({ width: 120, height: 76 })).toBe(1);
    expect(dataStoreScale({ width: 148, height: 64 })).toBe(1);
  });

  it('grows with the box, by the side that has grown least', () => {
    expect(dataStoreScale({ width: 296, height: 176 })).toBe(2);
    expect(dataStoreScale({ width: 400, height: 290 })).toBeCloseTo(400 / 148);
    // Stretched one way only: the glyph stays.
    expect(dataStoreScale({ width: 400, height: 88 })).toBe(1);
    expect(dataStoreScale({ width: 148, height: 400 })).toBe(1);
  });
});

describe('a Data Store drawn bigger', () => {
  it('is exactly what it always was at the default size — no group, no scale', () => {
    const shapes = describeNode(store(148, 88), ctx).shapes;
    expect(shapes.some((shape) => shape.t === 'group')).toBe(false);
  });

  it('draws its glyph as one scaled group, with strokes that keep their weight', () => {
    const shapes = describeNode(store(296, 176), ctx).shapes;
    const group = shapes.find((shape) => shape.t === 'group');
    expect(group).toMatchObject({ t: 'group', scale: 2, translate: { x: -148, y: 0 } });
    const outline = (group as Extract<typeof group, { t: 'group' }>).children.find((child) => child.t === 'path');
    // 1.5 at the default size; halved here because the group doubles it back.
    expect(outline).toMatchObject({ stroke: { width: 0.75 } });
    const svg = serialize(emitShape(group!)[0]!);
    expect(svg).toContain('transform="translate(-148 0) scale(2)"');
  });

  it('puts its caption under the bigger glyph, not where the small one ended', () => {
    const label = (height: number, width: number) =>
      describeNode(store(width, height), ctx).shapes.find((shape) => shape.t === 'text') as { y: number };
    expect(label(88, 148).y).toBeLessThan(label(176, 296).y);
    // Under the glyph's bottom edge (top 9 + height 42, doubled).
    expect(label(176, 296).y).toBeGreaterThanOrEqual((9 + 42) * 2);
  });

  it('lands its connectors on the bigger glyph', () => {
    const big = store(296, 176);
    expect(dataStoreGlyphBounds(big)).toEqual({ top: 18, bottom: 102, left: 94, right: 202 });
    const rect = rectOf(big);
    expect(anchorPoint(rect, 'left')).toEqual({ x: 94, y: 60 });
    expect(anchorPoint(rect, 'right')).toEqual({ x: 202, y: 60 });
    expect(anchorPoint(rect, 'top')).toEqual({ x: 148, y: 18 });
  });

  it('scales every kind, not just the cylinder', () => {
    for (const databaseKind of ['generic', 'sql', 'nosql', 'cache', 'file-system', 'object-storage', 'search-index', 'table'] as const) {
      const shapes = describeNode(store(296, 176, { databaseKind }), ctx).shapes;
      expect(shapes.find((shape) => shape.t === 'group'), databaseKind).toMatchObject({ scale: 2 });
    }
  });
});
