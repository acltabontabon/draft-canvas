import { describe, expect, it } from 'vitest';
import { cameraEntering, cameraLeaving, fitCamera } from '../src/canvas/depthCamera';

/** Stepping between rooms: lands where Fit to view would, and sets off from the shape the move is about. */

const pane = { width: 1000, height: 700 };
const room = [
  { x: 2000, y: 1500, width: 160, height: 70 },
  { x: 2400, y: 1700, width: 172, height: 102 },
];
const onScreen = (camera: { x: number; y: number; zoom: number }, box: { x: number; y: number; width: number; height: number }) => ({
  x: box.x * camera.zoom + camera.x,
  y: box.y * camera.zoom + camera.y,
  width: box.width * camera.zoom,
  height: box.height * camera.zoom,
});

describe('depth camera', () => {
  it('lands with the room centred, the way Fit to view frames it', () => {
    const landing = fitCamera(room, pane)!;
    const bounds = onScreen(landing, { x: 2000, y: 1500, width: 572, height: 302 });
    expect(bounds.x + bounds.width / 2).toBeCloseTo(500);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(350);
    expect(bounds.width).toBeLessThan(1000);
    expect(fitCamera([], pane)).toBeNull();
  });

  it('starts the room small inside the shape it belongs to', () => {
    const entrance = { x: 300, y: 200, width: 200, height: 100 };
    const start = cameraEntering(room, entrance)!;
    const bounds = onScreen(start, { x: 2000, y: 1500, width: 572, height: 302 });
    expect(bounds.x).toBeGreaterThan(entrance.x);
    expect(bounds.y).toBeGreaterThanOrEqual(entrance.y);
    expect(bounds.x + bounds.width).toBeLessThan(entrance.x + entrance.width);
    expect(bounds.x + bounds.width / 2).toBeCloseTo(400);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(250);
  });

  it('starts the climb with the shape around where the room’s shapes were', () => {
    const owner = { x: 100, y: 100, width: 160, height: 70 };
    const content = { x: 140, y: 100, width: 720, height: 500 };
    const start = cameraLeaving(owner, content);
    const shape = onScreen(start, owner);
    expect(shape.x + shape.width / 2).toBeCloseTo(500);
    expect(shape.y + shape.height / 2).toBeCloseTo(350);
    // Just outside them, as they sat just inside it going in; past the zoom limit a fit stops at.
    expect(shape.x).toBeLessThan(content.x);
    expect(shape.x + shape.width).toBeGreaterThan(content.x + content.width);
    expect(shape.y).toBeLessThan(content.y);
    expect(shape.y + shape.height).toBeGreaterThan(content.y + content.height);
    expect(start.zoom).toBeGreaterThan(4);
  });
});
