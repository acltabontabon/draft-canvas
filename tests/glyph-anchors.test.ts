import { describe, expect, it } from 'vitest';
import { dataStoreGlyphBounds, dataStoreScale } from '../src/document/dataStoreGeometry';
import { createNode } from '../src/document/factory';
import { anchorBandOf, bandSpan } from '../src/document/queueGeometry';
import type { DraftNode } from '../src/document/types';
import { anchorPoint, ANCHOR_OFFSETS, rectOf } from '../src/edges/routing';

/**
 * A shape drawn as a glyph takes its connectors on the glyph: its twelve connection points sit on
 * what is drawn, at every size of its box, and the glyph grows when its box is made bigger.
 */
const shape = (extra: Partial<DraftNode>, size?: { width: number; height: number }): DraftNode => ({
  ...createNode({ type: 'service', x: 100, y: 100, ...extra } as Parameters<typeof createNode>[0]),
  ...size,
});

describe('where a glyph takes its connectors', () => {
  it('keeps a default box\'s top and bottom anchors exactly where they were: a quarter, a half, three quarters of the box', () => {
    for (const node of [shape({ serviceKind: 'load-balancer' }), shape({ type: 'database' })]) {
      const rect = rectOf(node);
      for (const side of ['top', 'bottom'] as const) {
        ANCHOR_OFFSETS.forEach((offset) => expect(anchorPoint(rect, side, offset).x).toBeCloseTo(node.x + node.width * offset, 6));
      }
    }
  });

  it('keeps them on the glyph when the box is made wider for the words under it', () => {
    // 280 across around a glyph 70 across: the outer two were 70 from the middle, in the air.
    const node = shape({ serviceKind: 'gateway', description: 'Routes each request to the service that owns its path.' }, { width: 280, height: 143 });
    const rect = rectOf(node);
    const band = anchorBandOf(node)!;
    for (const side of ['top', 'bottom'] as const) {
      const xs = ANCHOR_OFFSETS.map((offset) => anchorPoint(rect, side, offset).x);
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(band.left!);
        expect(x).toBeLessThanOrEqual(band.right!);
      }
      // Still three apart, and the same three columns top and bottom.
      expect(xs[1]).toBeCloseTo(node.x + node.width / 2, 5);
      expect(xs[2]! - xs[1]!).toBeCloseTo(xs[1]! - xs[0]!, 5);
      expect(xs[2]! - xs[0]!).toBeGreaterThan((band.right! - band.left!) * 0.8);
    }
    // And an offset past the handles stops at the glyph's corner.
    expect(anchorPoint(rect, 'top', 0).x).toBe(band.left);
    expect(bandSpan(node, band, 'top').length).toBeLessThan(node.width);
  });

  it('puts a narrower glyph\'s side anchors on its own edge, not on the widest glyph\'s', () => {
    const wide = dataStoreGlyphBounds(shape({ serviceKind: 'worker' }));
    for (const node of [shape({ serviceKind: 'scheduler' }), shape({ type: 'component', componentKind: 'port' }), shape({ type: 'component', componentKind: 'module' })]) {
      const bounds = dataStoreGlyphBounds(node);
      expect(bounds.left).toBeGreaterThan(wide.left + 3);
      expect(bounds.right).toBeLessThan(wide.right - 3);
      expect((bounds.left + bounds.right) / 2).toBeCloseTo(node.x + node.width / 2, 5);
    }
  });

  it('leaves a card\'s on its box: Generic, API and External', () => {
    for (const serviceKind of ['generic', 'api', 'external'] as const) expect(anchorBandOf(shape({ serviceKind }))).toBeUndefined();
  });
});

describe('a glyph in a box made bigger', () => {
  it('grows from the first pixels of room, where it waited for a box 250 by 200', () => {
    const start = shape({ serviceKind: 'load-balancer', text: 'Edge' });
    const base = dataStoreScale(start);
    expect(base).toBeCloseTo(114 / 88, 5);
    const sizes = [{ width: 150, height: 150 }, { width: 180, height: 180 }, { width: 240, height: 230 }];
    const scales = sizes.map((size) => dataStoreScale({ ...start, ...size }));
    expect(scales[0]).toBeGreaterThan(base);
    expect(scales[1]).toBeGreaterThan(scales[0]!);
    expect(scales[2]).toBeGreaterThan(scales[1]!);
    // Its connection points go with it.
    const bigger = anchorBandOf({ ...start, ...sizes[1]! })!;
    const was = anchorBandOf(start)!;
    expect(bigger.right! - bigger.left!).toBeGreaterThan(was.right! - was.left!);
  });

  it('stays the size it was in a box that is only as big as its words need', () => {
    const base = 114 / 88;
    // Wider for a long name, taller for a description: no room to spare, so nothing changes.
    expect(dataStoreScale(shape({ serviceKind: 'worker', text: 'Nightly Reconciliation Worker' }, { width: 220, height: 114 }))).toBeCloseTo(base, 5);
    expect(
      dataStoreScale(shape({ serviceKind: 'worker', text: 'Worker', description: 'Reads the queue, charges the card, writes the ledger and retries what failed, with a backoff that doubles.' }, { width: 200, height: 190 })),
    ).toBeCloseTo(base, 5);
  });

  it('leaves a Data Store, which always grew with its box, exactly as it was', () => {
    const store = { ...createNode({ type: 'database', x: 0, y: 0 }), width: 180, height: 176 };
    expect(dataStoreScale(store)).toBeCloseTo(2, 5);
  });
});
