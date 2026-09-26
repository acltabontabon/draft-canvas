import { describe, expect, it } from 'vitest';
import {
  captionCornerFor,
  comfortablyShows,
  composeStep,
  frameOverview,
  frameStep,
  OVERVIEW_MAX_ZOOM,
  screenRectOf,
  STEP_MAX_ZOOM,
} from '../src/presentation/framing';

/**
 * The directed camera: stay when the interaction already reads, slide the least that brings it
 * in, and only recompose when it has to — never closer than two shapes filling the screen, as wide
 * as a long handoff needs.
 */
const view = { width: 1200, height: 800 };
const insets = { top: 56, right: 40, bottom: 120, left: 40 };

describe('frameStep', () => {
  it('holds still when the interaction already sits comfortably on screen', () => {
    const camera = { x: 100, y: 100, zoom: 1 };
    const box = { x: 200, y: 150, width: 400, height: 200 };
    expect(frameStep(box, camera, view, insets)).toEqual({ camera, kind: 'stay' });
    expect(comfortablyShows(box, camera, view, insets)).toBe(true);
  });

  it('slides the least that brings a step just off the edge back in, keeping the zoom', () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    // Right edge at 1250 — 90px past the safe area's right margin (1160 − 28).
    const box = { x: 850, y: 300, width: 400, height: 100 };
    const frame = frameStep(box, camera, view, insets);
    expect(frame.kind).toBe('nudge');
    expect(frame.camera.zoom).toBe(1);
    expect(frame.camera.y).toBe(0);
    expect(frame.camera.x).toBeCloseTo(1160 - 28 - 1250);
    // …and it now reads as comfortably visible, so a second press would hold still.
    expect(frameStep(box, frame.camera, view, insets).kind).toBe('stay');
  });

  it('cuts to a new composition rather than panning across the whole canvas', () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    const box = { x: 3000, y: 2400, width: 400, height: 100 };
    const frame = frameStep(box, camera, view, insets);
    expect(frame.kind).toBe('fit');
    const rect = screenRectOf(box, frame.camera);
    // Centred in the safe area, at the zoom the audience already had (close enough to ideal).
    expect(rect.x + rect.width / 2).toBeCloseTo(insets.left + (view.width - insets.left - insets.right) / 2);
    expect(rect.y + rect.height / 2).toBeCloseTo(insets.top + (view.height - insets.top - insets.bottom) / 2);
  });

  it('never zooms closer than the step limit on two adjacent shapes', () => {
    const camera = { x: 0, y: 0, zoom: 0.2 };
    const box = { x: 100, y: 100, width: 180, height: 60 };
    const frame = frameStep(box, camera, view, insets);
    expect(frame.kind).toBe('fit');
    expect(frame.camera.zoom).toBe(STEP_MAX_ZOOM);
  });

  it('goes as wide as a long handoff needs', () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    const box = { x: 0, y: 0, width: 4000, height: 300 };
    const frame = frameStep(box, camera, view, insets);
    expect(frame.kind).toBe('fit');
    const rect = screenRectOf(box, frame.camera);
    expect(rect.width).toBeLessThanOrEqual(view.width - insets.left - insets.right);
    expect(frame.camera.zoom).toBeLessThan(0.3);
  });

  it('reframes a step that is on screen but too small to read', () => {
    const camera = { x: 300, y: 200, zoom: 0.3 };
    const box = { x: 100, y: 100, width: 400, height: 200 };
    const frame = frameStep(box, camera, view, insets);
    expect(frame.kind).toBe('fit');
    expect(frame.camera.zoom).toBeGreaterThan(0.3);
  });

  it('answers stay against a view that has not been measured yet', () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    expect(frameStep({ x: 0, y: 0, width: 100, height: 100 }, camera, { width: 0, height: 0 }, insets).kind).toBe('stay');
  });
});

describe('composeStep', () => {
  it('is the frame a step gets from nothing — centred, never closer than the step limit', () => {
    const box = { x: 100, y: 100, width: 400, height: 200 };
    const fresh = composeStep(box, view, insets);
    expect(fresh.zoom).toBe(STEP_MAX_ZOOM);
    const rect = screenRectOf(box, fresh);
    expect(rect.x + rect.width / 2).toBeCloseTo(insets.left + (view.width - insets.left - insets.right) / 2);
    // Re-centre lands here even when the camera it replaces already showed the step well enough.
    expect(frameStep(box, fresh, view, insets).kind).toBe('stay');
    expect(frameStep(box, { x: fresh.x + 60, y: fresh.y + 60, zoom: fresh.zoom }, view, insets).kind).toBe('stay');
  });
});

describe('frameOverview', () => {
  it('fits the whole flow in the safe area, never closer than the overview limit', () => {
    const box = { x: 0, y: 0, width: 300, height: 120 };
    const camera = frameOverview(box, view, insets);
    expect(camera.zoom).toBe(OVERVIEW_MAX_ZOOM);
    const rect = screenRectOf(box, camera);
    expect(rect.x + rect.width / 2).toBeCloseTo(insets.left + (view.width - insets.left - insets.right) / 2);
  });

  it('zooms out for a large flow', () => {
    const box = { x: -1000, y: -500, width: 5000, height: 2000 };
    const camera = frameOverview(box, view, insets);
    const rect = screenRectOf(box, camera);
    expect(rect.x).toBeGreaterThanOrEqual(insets.left);
    expect(rect.y).toBeGreaterThanOrEqual(insets.top);
    expect(rect.x + rect.width).toBeLessThanOrEqual(view.width - insets.right);
    expect(rect.y + rect.height).toBeLessThanOrEqual(view.height - insets.bottom);
  });
});

describe('captionCornerFor', () => {
  const size = { width: 340, height: 120 };

  it('prefers the bottom-left, and keeps it with nothing framed', () => {
    expect(captionCornerFor(null, view, insets, size)).toBe('bottom-left');
    expect(captionCornerFor({ x: 600, y: 100, width: 200, height: 100 }, view, insets, size)).toBe('bottom-left');
  });

  it('moves out of the way of an interaction framed over it', () => {
    // Sitting exactly where the bottom-left caption would go.
    expect(captionCornerFor({ x: 40, y: 560, width: 300, height: 100 }, view, insets, size)).toBe('bottom-right');
    // Spanning the whole bottom: up it goes.
    expect(captionCornerFor({ x: 40, y: 560, width: 1100, height: 100 }, view, insets, size)).toBe('top-left');
  });

  it('settles for the least covered corner when every corner is under the interaction', () => {
    const everywhere = { x: -100, y: -100, width: 1400, height: 1000 };
    expect(captionCornerFor(everywhere, view, insets, size)).toBe('bottom-left');
  });
});
