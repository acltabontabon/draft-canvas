import { describe, expect, it } from 'vitest';
import { CHIP_HEIGHT, CHIP_WIDTH, chipPlace, revealViewport } from '../../src/desktop/ui/chipPlace';

/** The proposal's chip sits beside the change it describes, never over it, and never off the canvas. */

const view = { width: 1280, height: 640 };
const identity: [number, number, number] = [0, 0, 1];

describe('chipPlace', () => {
  it('goes to the left of the change when there is room', () => {
    expect(chipPlace({ x: 800, y: 300, width: 120, height: 120 }, identity, view)).toEqual({ left: 800 - 12 - CHIP_WIDTH, top: 300 });
  });

  it('goes above, then right, then below when the left is taken by the edge', () => {
    expect(chipPlace({ x: 100, y: 300, width: 120, height: 120 }, identity, view)).toEqual({ left: 100, top: 300 - 12 - CHIP_HEIGHT });
    expect(chipPlace({ x: 100, y: 40, width: 120, height: 120 }, identity, view)).toEqual({ left: 232, top: 40 });
  });

  it('follows the camera, and stays on the canvas while the change is off it', () => {
    expect(chipPlace({ x: 400, y: 150, width: 100, height: 100 }, [100, 50, 2], view)).toEqual({ left: 900 - 12 - CHIP_WIDTH, top: 350 });
    const off = chipPlace({ x: 5000, y: 5000, width: 100, height: 100 }, identity, view);
    expect(off.left).toBeLessThanOrEqual(view.width - CHIP_WIDTH - 12);
    expect(off.top).toBeLessThanOrEqual(view.height - CHIP_HEIGHT - 12);
  });

  it('keeps a tall chip on the canvas, by its height as drawn', () => {
    const tall = chipPlace({ x: 5000, y: 5000, width: 100, height: 100 }, identity, view, 400);
    expect(tall.top).toBe(view.height - 400 - 12);
  });

  it('never sits under Nodi: beside it, else above it', () => {
    const nodi = { x: 840, y: 240, width: 424, height: 384 };
    // Pushed into the bottom-right corner, where Nodi is: it goes to Nodi's left.
    const cornered = chipPlace({ x: 5000, y: 5000, width: 100, height: 100 }, identity, view, CHIP_HEIGHT, nodi);
    expect(cornered.left + CHIP_WIDTH).toBeLessThanOrEqual(nodi.x);
    // A change right beside Nodi skips the place that would cover it.
    const beside = chipPlace({ x: 700, y: 400, width: 100, height: 100 }, identity, view, CHIP_HEIGHT, nodi);
    const overlaps = beside.left < nodi.x + nodi.width && beside.left + CHIP_WIDTH > nodi.x && beside.top < nodi.y + nodi.height && beside.top + CHIP_HEIGHT > nodi.y;
    expect(overlaps).toBe(false);
  });

  it('waits at the top-left while the change is in another view', () => {
    expect(chipPlace(null, identity, view)).toEqual({ left: 12, top: 12 });
  });
});

describe('revealViewport', () => {
  const free = { width: 840, height: 640 };

  it('leaves the camera alone when the change is already in view', () => {
    expect(revealViewport({ x: 300, y: 200, width: 120, height: 120 }, identity, free)).toBeNull();
  });

  it('pans just far enough to clear the companion, at the same zoom', () => {
    expect(revealViewport({ x: 790, y: 390, width: 120, height: 140 }, identity, free)).toEqual({ x: 840 - 48 - 910, y: 0, zoom: 1 });
  });

  it('zooms out, never in, when the change does not fit', () => {
    const out = revealViewport({ x: 0, y: 0, width: 2000, height: 300 }, identity, free)!;
    expect(out.zoom).toBeLessThan(1);
    // Already in view while zoomed out: left as it is, not zoomed back in.
    expect(revealViewport({ x: 200, y: 200, width: 10, height: 10 }, [0, 0, 0.5], free)).toBeNull();
  });
});
