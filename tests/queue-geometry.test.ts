import { describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { anchorBandOf, queueTubeSpan } from '../src/document/queueGeometry';
import { rectOf } from '../src/edges/routing';

describe('queue tube geometry', () => {
  it('mirrors the renderer: a 0.75 inset and a tube of at most 32px, at most half the box', () => {
    expect(queueTubeSpan(48)).toEqual({ top: 0.75, bottom: 0.75 + 23.25 });
    expect(queueTubeSpan(68)).toEqual({ top: 0.75, bottom: 32.75 });
    expect(queueTubeSpan(72)).toEqual({ top: 0.75, bottom: 32.75 });
  });

  it('gives a queue-family node an absolute band and every other node none', () => {
    expect(anchorBandOf({ type: 'queue', y: 100, height: 48 })).toEqual({ top: 100.75, bottom: 124 });
    expect(anchorBandOf({ type: 'service', y: 100, height: 48 })).toBeUndefined();
    expect(anchorBandOf({ type: 'database', y: 100, height: 88 })).toBeUndefined();
  });

  it('rectOf carries the band for a queue and stays a plain box for a service', () => {
    const queue = createNode({ type: 'queue', x: 10, y: 20, width: 140, height: 48 });
    const service = createNode({ type: 'service', x: 10, y: 20, width: 176, height: 68 });
    expect(rectOf(queue).anchorBand).toEqual({ top: 20.75, bottom: 44 });
    expect(rectOf(service)).toEqual({ x: 10, y: 20, width: 176, height: 68 });
    expect('anchorBand' in rectOf(service)).toBe(false);
  });
});
