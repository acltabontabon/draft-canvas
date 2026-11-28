import { describe, expect, it } from 'vitest';
import { revealViewport } from '../../src/desktop/ui/revealViewport';

const identity: [number, number, number] = [0, 0, 1];

describe('revealViewport', () => {
  const free = { width: 840, height: 640 };

  it('leaves the camera alone when the change is already in view', () => {
    expect(revealViewport({ x: 300, y: 200, width: 120, height: 120 }, identity, free)).toBeNull();
  });

  it('pans just far enough to clear the review panel, at the same zoom', () => {
    expect(revealViewport({ x: 790, y: 390, width: 120, height: 140 }, identity, free)).toEqual({ x: 840 - 48 - 910, y: 0, zoom: 1 });
  });

  it('zooms out, never in, when the change does not fit', () => {
    const out = revealViewport({ x: 0, y: 0, width: 2000, height: 300 }, identity, free)!;
    expect(out.zoom).toBeLessThan(1);
    // Already in view while zoomed out: left as it is, not zoomed back in.
    expect(revealViewport({ x: 200, y: 200, width: 10, height: 10 }, [0, 0, 0.5], free)).toBeNull();
  });
});
