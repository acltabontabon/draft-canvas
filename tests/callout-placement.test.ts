import { describe, expect, it } from 'vitest';
import { overlapArea } from '../src/lib/math';
import {
  CALLOUT_GAP,
  leaderBetween,
  placeCallout,
  segmentBoxes,
  type Box,
  type CalloutPlacementInput,
} from '../src/presentation/calloutPlacement';

const bounds: Box = { x: 16, y: 16, width: 1368, height: 868 };
const flowBar: Box = { x: 400, y: 820, width: 600, height: 44 };
const size = { width: 300, height: 90 };

/** A horizontal connector from (300, 450) to (700, 450), chip row centred just above its middle. */
function edgeInput(overrides: Partial<CalloutPlacementInput> = {}): CalloutPlacementInput {
  const marker: Box = { x: 480, y: 420, width: 40, height: 18 };
  return {
    kind: 'edge',
    marker,
    host: marker,
    avoid: [
      { x: 180, y: 410, width: 120, height: 80 },
      { x: 700, y: 410, width: 120, height: 80 },
    ],
    soft: segmentBoxes(
      [
        { x: 300, y: 450 },
        { x: 700, y: 450 },
      ],
      8,
    ),
    exclusions: [flowBar],
    bounds,
    size,
    dockTo: flowBar,
    ...overrides,
  };
}

function rectOf(result: { x: number; y: number }): Box {
  return { x: result.x, y: result.y, width: size.width, height: size.height };
}

const inside = (rect: Box, outer: Box) =>
  rect.x >= outer.x - 0.01 &&
  rect.y >= outer.y - 0.01 &&
  rect.x + rect.width <= outer.x + outer.width + 0.01 &&
  rect.y + rect.height <= outer.y + outer.height + 0.01;

describe('placeCallout for a connector', () => {
  it('sits above the marker with a short vertical thread when there is room', () => {
    const result = placeCallout(edgeInput());
    expect(result.placement).toBe('above');
    expect(result.y + size.height).toBe(420 - CALLOUT_GAP);
    expect(result.leader).toEqual({ x1: 500, y1: 420, x2: 500, y2: 420 - CALLOUT_GAP });
  });

  it('flips below when the canvas top is too close', () => {
    const marker: Box = { x: 480, y: 40, width: 40, height: 18 };
    const result = placeCallout(edgeInput({ marker, host: marker, avoid: [], soft: [] }));
    expect(result.placement).toBe('below');
    expect(inside(rectOf(result), bounds)).toBe(true);
  });

  it('starts below when the chip row already hangs below the line', () => {
    expect(placeCallout(edgeInput({ preferBelow: true })).placement).toBe('below');
  });

  it('steps to a diagonal when nodes block straight above and below', () => {
    const blockers = [
      { x: 450, y: 250, width: 80, height: 150 },
      { x: 450, y: 470, width: 80, height: 150 },
    ];
    const result = placeCallout(edgeInput({ avoid: blockers }));
    expect(['above-right', 'above-left', 'right', 'left']).toContain(result.placement);
    for (const blocker of blockers) expect(overlapArea(rectOf(result), blocker)).toBe(0);
  });

  it('never lands on the flow bar', () => {
    const marker: Box = { x: 680, y: 760, width: 40, height: 18 };
    const result = placeCallout(edgeInput({ marker, host: marker, avoid: [], soft: [] }));
    expect(overlapArea(rectOf(result), flowBar)).toBe(0);
    expect(inside(rectOf(result), bounds)).toBe(true);
  });

  it('settles on the best clean spot even when it already holds another', () => {
    expect(placeCallout(edgeInput({ current: 'below' })).placement).toBe('above');
  });

  it('holds its placement on a crowded canvas instead of hopping for no gain', () => {
    const crowd = [{ x: 0, y: 0, width: 1400, height: 900 }];
    expect(placeCallout(edgeInput({ soft: crowd })).placement).toBe('above');
    expect(placeCallout(edgeInput({ soft: crowd, current: 'below' })).placement).toBe('below');
  });

  it('docks above the flow bar on a narrow canvas', () => {
    const narrow: Box = { x: 16, y: 16, width: 400, height: 700 };
    const result = placeCallout(edgeInput({ bounds: narrow, size: { width: 380, height: 90 } }));
    expect(result.placement).toBe('docked');
    expect(result.leader).toBeNull();
    expect(result.y + 90).toBeLessThanOrEqual(flowBar.y);
  });
});

describe('placeCallout for a node', () => {
  const host: Box = { x: 600, y: 400, width: 200, height: 90 };
  const badge: Box = { x: 750, y: 378, width: 44, height: 18 };
  const nodeInput = (overrides: Partial<CalloutPlacementInput> = {}): CalloutPlacementInput => ({
    kind: 'node',
    marker: badge,
    host,
    avoid: [host],
    soft: [],
    exclusions: [flowBar],
    bounds,
    size,
    dockTo: flowBar,
    ...overrides,
  });

  it('opens upper-right from its badge', () => {
    const result = placeCallout(nodeInput());
    expect(result.placement).toBe('above-right');
    expect(overlapArea(rectOf(result), host)).toBe(0);
    expect(result.leader).not.toBeNull();
  });

  it('threads a callout below the node from the node itself, never across it', () => {
    const blocked = [
      host,
      { x: 300, y: 200, width: 900, height: 175 },
      { x: 820, y: 380, width: 400, height: 100 },
      { x: 300, y: 380, width: 280, height: 100 },
    ];
    const result = placeCallout(nodeInput({ avoid: blocked }));
    expect(result.placement).toBe('below');
    expect(result.leader).not.toBeNull();
    expect(result.leader!.y1).toBe(host.y + host.height);
  });

  it('never covers the node it annotates, even pressed into a corner', () => {
    const cornerHost: Box = { x: 1180, y: 20, width: 200, height: 90 };
    const cornerBadge: Box = { x: 1330, y: 16, width: 44, height: 18 };
    const result = placeCallout(nodeInput({ host: cornerHost, marker: cornerBadge, avoid: [cornerHost] }));
    expect(result.placement).not.toBe('docked');
    expect(overlapArea(rectOf(result), cornerHost)).toBe(0);
    expect(inside(rectOf(result), bounds)).toBe(true);
  });
});

describe('leaderBetween', () => {
  it('runs straight across where the boxes overlap on an axis, and is null when they touch', () => {
    expect(leaderBetween({ x: 0, y: 100, width: 20, height: 20 }, { x: 40, y: 90, width: 50, height: 50 })).toEqual({
      x1: 20,
      y1: 110,
      x2: 40,
      y2: 110,
    });
    expect(leaderBetween({ x: 0, y: 0, width: 20, height: 20 }, { x: 10, y: 10, width: 20, height: 20 })).toBeNull();
  });
});
