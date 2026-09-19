import { describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { anchorBandOf, queueTubeSpan } from '../src/document/queueGeometry';
import { anchorPoint, rectOf } from '../src/edges/routing';

describe('queue tube geometry', () => {
  it('mirrors the renderer: a 0.75 inset and a tube of at most 32px, at most half the box', () => {
    expect(queueTubeSpan(48)).toEqual({ top: 0.75, bottom: 0.75 + 23.25 });
    expect(queueTubeSpan(68)).toEqual({ top: 0.75, bottom: 32.75 });
    expect(queueTubeSpan(72)).toEqual({ top: 0.75, bottom: 32.75 });
  });

  it('gives a queue-family node an absolute band and every other node none', () => {
    expect(anchorBandOf({ type: 'queue', x: 0, y: 100, width: 176, height: 48 })).toEqual({ top: 100.75, bottom: 124 });
    expect(anchorBandOf({ type: 'service', x: 0, y: 100, width: 176, height: 48 })).toBeUndefined();
    expect(anchorBandOf({ type: 'actor', x: 0, y: 100, width: 96, height: 96 })).toBeUndefined();
  });

  it('rectOf carries the band for a queue and stays a plain box for a service', () => {
    const queue = createNode({ type: 'queue', x: 10, y: 20, width: 140, height: 48 });
    const service = createNode({ type: 'service', x: 10, y: 20, width: 176, height: 68 });
    expect(rectOf(queue).anchorBand).toEqual({ top: 20.75, bottom: 44 });
    expect(rectOf(service)).toEqual({ x: 10, y: 20, width: 176, height: 68 });
    expect('anchorBand' in rectOf(service)).toBe(false);
  });

  it('gives a Data Store the glyph it draws, not the empty margin around it', () => {
    // 148 wide, 88 tall: a 54-wide glyph centred in it, from 9 down to 51.
    const band = anchorBandOf({ type: 'database', x: 100, y: 200, width: 148, height: 88 });
    expect(band).toEqual({ top: 209, bottom: 251, left: 147, right: 201, glyphTop: 209 });
  });

  it('lands a connector on the Data Store glyph on every side that leaves through it', () => {
    const store = createNode({ type: 'database', x: 100, y: 200, width: 148, height: 88 });
    const rect = rectOf(store);
    // Left and right meet the glyph's own edges, at its mid-height; the top meets its top.
    expect(anchorPoint(rect, 'left')).toEqual({ x: 147, y: 230 });
    expect(anchorPoint(rect, 'right')).toEqual({ x: 201, y: 230 });
    expect(anchorPoint(rect, 'top')).toEqual({ x: 174, y: 209 });
    // Below the captions, as for a queue: the bottom is still the box's.
    expect(anchorPoint(rect, 'bottom')).toEqual({ x: 174, y: 288 });
  });

  it('keeps the Data Store glyph inside the box however narrow it is resized', () => {
    const band = anchorBandOf({ type: 'database', x: 0, y: 0, width: 120, height: 76 })!;
    expect(band.left).toBeGreaterThanOrEqual(0);
    expect(band.right).toBeLessThanOrEqual(120);
    expect(band.bottom).toBeLessThanOrEqual(76);
  });
});
