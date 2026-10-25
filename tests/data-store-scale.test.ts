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
 * ordinary sizes keep their established scale, while a much larger box uses more of its free space.
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

  it('grows with spare space while reserving room for its caption', () => {
    expect(dataStoreScale({ width: 296, height: 176 })).toBe(2);
    expect(dataStoreScale({ width: 400, height: 290 })).toBeCloseTo(204 / 42);
    expect(dataStoreScale({ width: 120, height: 114 })).toBeCloseTo(114 / 88);
    // Stretching just one axis does not trigger the denser resized treatment.
    expect(dataStoreScale({ width: 400, height: 88 })).toBe(1);
    expect(dataStoreScale({ width: 90, height: 400 })).toBe(1);
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
    const scale = dataStoreScale({ width: 296, height: 176 });
    expect(group).toMatchObject({ t: 'group', scale, translate: { x: -148, y: 0 } });
    const outline = (group as Extract<typeof group, { t: 'group' }>).children.find((child) => child.t === 'path');
    expect(outline).toMatchObject({ stroke: { width: 1.5 / scale } });
    const svg = serialize(emitShape(group!)[0]!);
    expect(svg).toContain(`scale(${scale})`);
  });

  it('puts its caption under the bigger glyph, not where the small one ended', () => {
    const label = (height: number, width: number) =>
      describeNode(store(width, height), ctx).shapes.find((shape) => shape.t === 'text') as { y: number };
    expect(label(88, 148).y).toBeLessThan(label(176, 296).y);
    expect(label(176, 296).y).toBeGreaterThanOrEqual(9 + 42 * dataStoreScale({ width: 296, height: 176 }));
  });

  it('lands its connectors on the bigger glyph', () => {
    const big = store(296, 176);
    const scale = dataStoreScale(big);
    const bounds = dataStoreGlyphBounds(big);
    expect(bounds.top).toBe(18);
    expect(bounds.bottom).toBeCloseTo(51 * scale);
    expect(bounds.left).toBeCloseTo(148 - 54 * scale / 2);
    expect(bounds.right).toBeCloseTo(148 + 54 * scale / 2);
    const rect = rectOf(big);
    expect(anchorPoint(rect, 'left')).toEqual({ x: bounds.left, y: (bounds.top + bounds.bottom) / 2 });
    expect(anchorPoint(rect, 'right')).toEqual({ x: bounds.right, y: (bounds.top + bounds.bottom) / 2 });
    expect(anchorPoint(rect, 'top')).toEqual({ x: 148, y: 18 });
  });

  it('scales every kind, not just the cylinder', () => {
    for (const databaseKind of ['generic', 'sql', 'nosql', 'cache', 'file-system', 'object-storage', 'search-index', 'table'] as const) {
      const shapes = describeNode(store(296, 176, { databaseKind }), ctx).shapes;
      expect(shapes.find((shape) => shape.t === 'group'), databaseKind).toMatchObject({ scale: dataStoreScale({ width: 296, height: 176 }) });
    }
  });

  it('fills a large resized box without pushing the name out', () => {
    const big = store(315, 270);
    const glyph = dataStoreGlyphBounds(big);
    const label = describeNode(big, ctx).shapes.find((shape) => shape.t === 'text' && shape.role === 'label');
    expect(glyph.right - glyph.left).toBeGreaterThan(big.width * 0.7);
    expect(glyph.top).toBeLessThan(28);
    expect(label?.t === 'text' && label.y).toBeGreaterThan(glyph.bottom);
    expect(label?.t === 'text' && label.y + label.layout.height).toBeLessThan(big.height);
  });
});
