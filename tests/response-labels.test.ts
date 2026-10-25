import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { EDGE_ROUTINGS, type EdgeAnchor, type Side } from '../src/document/types';
import { describeEdge } from '../src/edges/describe';
import { distanceToPath } from '../src/edges/nearest';
import {
  rectOf, responseLabelAnchor, responseLaneFor, responseSpineFor, routeBetween,
  type Rect,
} from '../src/edges/routing';
import { StaticTextMeasurer } from '../src/render/text/measure';
import { DARK, LIGHT } from '../src/render/theme/tokens';

const source: Rect = { x: 0, y: 0, width: 160, height: 100 };
const target: Rect = { ...source, x: 300, y: 250 };
const sourceAnchor: EdgeAnchor = { side: 'bottom', offset: 0.5 };
const targetAnchor: EdgeAnchor = { side: 'left', offset: 0.5 };
const horizontal = (side: Side) => side === 'top' || side === 'bottom';

function pair(a = source, b = target, from = sourceAnchor, to = targetAnchor) {
  const request = routeBetween(a, b, 'smoothstep', { anchors: { source: from, target: to } });
  const response = routeBetween(b, a, 'smoothstep', { anchors: { source: to, target: from }, replyStep: responseLaneFor(0) });
  return { request, response, label: responseLabelAnchor(request, response, a, b) };
}

function rotateRect(rect: Rect): Rect {
  return { x: -rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width };
}
const rotatedSide: Record<Side, Side> = { top: 'right', right: 'bottom', bottom: 'left', left: 'top' };

describe('enabled response label placement', () => {
  it('does not follow the reply midpoint when a one-pixel move changes its longest leg', () => {
    const before = pair(source, { ...target, y: 234 });
    const after = pair(source, { ...target, y: 235 });
    expect(horizontal(before.response.labelSide)).toBe(true);
    expect(horizontal(after.response.labelSide)).toBe(false);
    expect(Math.hypot(after.label.x - before.label.x, after.label.y - before.label.y)).toBeCloseTo(1);
  });

  it.each([
    { x: -400, y: -63, source: 'right', target: 'left' },
    { x: 500, y: -65, source: 'left', target: 'right' },
    { x: 150, y: 125, source: 'right', target: 'top' },
    { x: 150, y: 125, source: 'right', target: 'bottom' },
    { x: 150, y: 141, source: 'right', target: 'top' },
    { x: 150, y: 141, source: 'right', target: 'bottom' },
  ] as const)('stays on the matching run near a corner or a changed attachment side ($x, $y, $source → $target)', (fixture) => {
    const b = { ...target, x: fixture.x, y: fixture.y };
    const from = { side: fixture.source, offset: 0.5 };
    const to = { side: fixture.target, offset: 0.5 };
    const before = pair(source, b, from, to);
    const after = pair(source, { ...b, y: b.y + 1 }, from, to);
    expect(Math.hypot(after.label.x - before.label.x, after.label.y - before.label.y)).toBeLessThan(2);
    expect(after.label.side).toBe(before.label.side);
    expect(distanceToPath(after.label, after.response.d)).toBeCloseTo(0);
  });

  it.each([0, 1, 2, 3])('pairs the labels on an L rotated by %s quarter turns', (turns) => {
    let a = source;
    let b = target;
    let from = sourceAnchor;
    let to = targetAnchor;
    for (let n = 0; n < turns; n += 1) {
      a = rotateRect(a);
      b = rotateRect(b);
      from = { ...from, side: rotatedSide[from.side] };
      to = { ...to, side: rotatedSide[to.side] };
    }
    const { request, response, label } = pair(a, b, from, to);
    const along = horizontal(request.labelSide) ? 'x' : 'y';
    expect(label[along]).toBeCloseTo(along === 'x' ? request.labelX : request.labelY);
    expect(Math.hypot(label.x - request.labelX, label.y - request.labelY)).toBeLessThan(30);
    expect(distanceToPath(label, response.d)).toBeCloseTo(0);
    expect(horizontal(label.side)).toBe(horizontal(request.labelSide));
  });

  it.each(EDGE_ROUTINGS)('keeps %s reply labels on their own rail for positive and negative sibling lanes', (routing) => {
    const b = { ...target, y: 0 };
    for (const lane of [-1.5, -0.5, 0, 0.5, 1.5]) {
      const request = routeBetween(source, b, routing, { lane });
      const response = routeBetween(b, source, routing, { lane, replyStep: responseLaneFor(lane) - lane });
      const label = responseLabelAnchor(request, response, source, b, lane);
      expect(distanceToPath(label, response.d)).toBeCloseTo(0);
      expect(label.x).toBeCloseTo(request.labelX);
      expect(label.side).toBe(lane < 0 ? 'top' : 'bottom');
    }
  });

  it('keeps a bundled reply on its own branch in a narrow corridor', () => {
    const a = { ...source, x: 0, y: 200 };
    const b = { ...target, x: 260, y: 0 };
    const spine = { id: 'fan', hub: 'source', hubSide: 'right', trunkGap: 60, corridor: 100, count: 3 } as const;
    const request = routeBetween(a, b, 'smoothstep', { spine });
    const response = routeBetween(b, a, 'smoothstep', { spine: responseSpineFor(spine), replyStep: responseLaneFor(0) });
    const label = responseLabelAnchor(request, response, a, b);
    expect(label.x).toBe(response.labelX);
    expect(label.y).toBe(response.labelY);
    expect(distanceToPath(label, response.d)).toBeCloseTo(0);
  });

  it('keeps words on the reply when an obstacle sends the two rails around opposite sides', () => {
    const b = { ...target, x: 500, y: 0 };
    const obstacles = [{ x: 230, y: -300, width: 120, height: 700 }];
    const request = routeBetween(source, b, 'smoothstep', { obstacles });
    const response = routeBetween(b, source, 'smoothstep', { obstacles, replyStep: responseLaneFor(0) });
    const label = responseLabelAnchor(request, response, source, b);
    expect(request.labelY).toBeLessThan(-300);
    // Projecting onto the nearest run alone would move the words onto an endpoint leg.
    expect(label.y).toBeGreaterThan(400);
    expect(label.x).toBe(request.labelX);
    expect(label.side).toBe('bottom');
    expect(distanceToPath(label, response.d)).toBeCloseTo(0);
  });

  it.each([LIGHT, DARK])('exports the reply below the request on their corresponding horizontal runs ($name)', (theme) => {
    const a = createNode({ type: 'service', ...source, text: 'Caller' });
    const b = createNode({ type: 'service', ...target, text: 'Callee' });
    const edge = { ...createEdge({ source: a.id, target: b.id, label: 'Request', sourceAnchor, targetAnchor, hasResponse: true }), response: 'Reply' };
    const nodes = new Map([[a.id, a], [b.id, b]]);
    const described = describeEdge(edge, nodes, { theme, measurer: new StaticTextMeasurer(), showSequence: false })!;
    const words = described.overlay.filter((shape) => shape.t === 'text');
    const request = words.find((shape) => shape.layout.lines[0]?.text === 'Request')!;
    const response = words.find((shape) => shape.layout.lines[0]?.text === 'Reply')!;
    // Both labels must be centred at x=180, well away
    // from the reply's independent longest-run midpoint at x=98 on the vertical leg.
    expect(request.align).toBe('middle');
    expect(request.x).toBeCloseTo(180);
    expect(response.x + response.layout.width / 2).toBeCloseTo(180);
    const requestRoute = routeBetween(rectOf(a), rectOf(b), edge.routing, { anchors: { source: sourceAnchor, target: targetAnchor } });
    expect(response.y).toBeGreaterThan(requestRoute.labelY + 18);
    expect(response.y).toBeGreaterThan(request.y + request.layout.height);
  });
});
