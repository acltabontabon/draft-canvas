import { afterEach, describe, expect, it } from 'vitest';
import { pointer, pointerFlow } from '../src/store/uiStore';

/**
 * Where the pointer is on the canvas is worked out when a shortcut asks, from the camera as it
 * stands then — not converted on every pointer move and again on every camera frame to keep a copy
 * fresh. A shortcut still puts its shape where the cursor is, whether the camera or the cursor moved.
 */

/** A camera: canvas = (screen − offset) / zoom, as React Flow's `screenToFlowPosition` is. */
function camera(offset: { x: number; y: number }, zoom: number) {
  return (point: { x: number; y: number }) => ({ x: (point.x - offset.x) / zoom, y: (point.y - offset.y) / zoom });
}

afterEach(() => {
  pointer.toFlow = null;
  pointer.known = false;
});

describe('the pointer on the canvas', () => {
  it('is the screen point taken through the camera as it is when asked', () => {
    pointer.screenX = 500;
    pointer.screenY = 300;
    pointer.known = true;
    pointer.toFlow = camera({ x: 100, y: 100 }, 2);
    expect(pointerFlow()).toEqual({ x: 200, y: 100 });
  });

  it('follows a camera that moves under a cursor that has not', () => {
    pointer.screenX = 500;
    pointer.screenY = 300;
    pointer.known = true;
    pointer.toFlow = camera({ x: 0, y: 0 }, 1);
    expect(pointerFlow()).toEqual({ x: 500, y: 300 });
    // A zoom, a fit, a trackpad pan: no pointer event comes, and the answer is still the spot under it.
    pointer.toFlow = camera({ x: -200, y: 50 }, 0.5);
    expect(pointerFlow()).toEqual({ x: 1400, y: 500 });
  });

  it('follows a cursor that moves over a camera that has not', () => {
    pointer.toFlow = camera({ x: 0, y: 0 }, 4);
    pointer.screenX = 40;
    pointer.screenY = 80;
    expect(pointerFlow()).toEqual({ x: 10, y: 20 });
    pointer.screenX = 400;
    expect(pointerFlow()).toEqual({ x: 100, y: 20 });
  });

  it('answers the screen point while no canvas has registered a conversion', () => {
    pointer.screenX = 12;
    pointer.screenY = 34;
    expect(pointerFlow()).toEqual({ x: 12, y: 34 });
  });
});
