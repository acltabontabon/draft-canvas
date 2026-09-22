import { describe, expect, it } from 'vitest';
import { OPEN_FIT_MIN_ZOOM, OPEN_FIT_PADDING, openFitViewport } from '../src/document/geometry';

/** Where `openFitViewport`'s chosen `{x, y, zoom}` puts a bounds rect's centre on screen. */
function screenCenterOf(viewport: { x: number; y: number; zoom: number }, bounds: { x: number; y: number; width: number; height: number }) {
  return {
    x: (bounds.x + bounds.width / 2) * viewport.zoom + viewport.x,
    y: (bounds.y + bounds.height / 2) * viewport.zoom + viewport.y,
  };
}

describe('openFitViewport', () => {
  const screen = { width: 1200, height: 800 };

  it('is null with nothing to fit', () => {
    expect(openFitViewport(null, screen)).toBeNull();
  });

  it('is null when the screen has not been measured yet', () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    expect(openFitViewport(bounds, { width: 0, height: 800 })).toBeNull();
    expect(openFitViewport(bounds, { width: 1200, height: 0 })).toBeNull();
  });

  it('opens a small diagram at 100% zoom, centred', () => {
    const bounds = { x: 0, y: 0, width: 200, height: 100 };
    const viewport = openFitViewport(bounds, screen)!;
    expect(viewport.zoom).toBe(1);
    const center = screenCenterOf(viewport, bounds);
    expect(center.x).toBeCloseTo(screen.width / 2);
    expect(center.y).toBeCloseTo(screen.height / 2);
  });

  it('never zooms in past 100% no matter how small the diagram', () => {
    const bounds = { x: 40, y: 40, width: 8, height: 8 };
    const viewport = openFitViewport(bounds, screen)!;
    expect(viewport.zoom).toBe(1);
  });

  it('zooms out just enough to show a diagram larger than the screen', () => {
    const bounds = { x: 0, y: 0, width: 4000, height: 800 };
    const viewport = openFitViewport(bounds, screen)!;
    expect(viewport.zoom).toBeLessThan(1);
    // The fit is exact against whichever axis is tighter, once padding is taken out.
    const expectedZoom = (screen.width - OPEN_FIT_PADDING * 2) / bounds.width;
    expect(viewport.zoom).toBeCloseTo(expectedZoom);
    const center = screenCenterOf(viewport, bounds);
    expect(center.x).toBeCloseTo(screen.width / 2);
    expect(center.y).toBeCloseTo(screen.height / 2);
  });

  it('centres a diagram positioned far from the coordinate origin', () => {
    const bounds = { x: 50000, y: -30000, width: 300, height: 150 };
    const viewport = openFitViewport(bounds, screen)!;
    expect(viewport.zoom).toBe(1);
    const center = screenCenterOf(viewport, bounds);
    expect(center.x).toBeCloseTo(screen.width / 2);
    expect(center.y).toBeCloseTo(screen.height / 2);
  });

  it('never asks for less zoom than the app supports, even for an enormous diagram', () => {
    const bounds = { x: 0, y: 0, width: 200000, height: 200000 };
    const viewport = openFitViewport(bounds, screen)!;
    expect(viewport.zoom).toBe(OPEN_FIT_MIN_ZOOM);
  });

  it('honours a custom padding', () => {
    const bounds = { x: 0, y: 0, width: 4000, height: 800 };
    const tight = openFitViewport(bounds, screen, 0)!;
    const padded = openFitViewport(bounds, screen, OPEN_FIT_PADDING)!;
    expect(tight.zoom).toBeGreaterThan(padded.zoom);
  });
});
