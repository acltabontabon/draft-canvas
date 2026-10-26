import { describe, expect, it } from 'vitest';
import { routeBetween, rectOf } from '../src/edges/routing';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { stepPolyline } from '../src/edges/waypoints';
import { autoAttachEnds } from '../src/document/operations';
import { nearbyServicesDocument } from './fixtures/connectors/nearby';

const rotate = (r: { x: number; y: number; width: number; height: number }) => ({ x: -r.y - r.height, y: r.x, width: r.height, height: r.width });

describe('closest clear attachment on facing sides', () => {
  it.each([0, 1, 2, 3])('uses the shared side band instead of two bends, rotated %s quarter turns', turns => {
    let source = { x: 0, y: 0, width: 350, height: 134 };
    let target = { x: 410, y: 41, width: 350, height: 134 };
    for (let i = 0; i < turns; i += 1) { source = rotate(source); target = rotate(target); }
    const route = routeBetween(source, target, 'smoothstep');
    const points = stepPolyline(route.d);
    const axis = turns % 2 === 0 ? 'y' : 'x';
    expect(new Set(points.map(p => p[axis])).size).toBe(1);
    expect(Math.hypot(route.target.x - route.source.x, route.target.y - route.source.y)).toBe(60);
    expect(route.status).toBe('clear');
  });

  it('aligns the available end to a planned shared-side slot without moving the slot', () => {
    const document = nearbyServicesDocument();
    const route = connectorRoutes(document.edges[0]!, document, 'transient')!.request;
    expect(route.source.side).toBe('right');
    expect(route.target.side).toBe('left');
    expect(route.target.y).toBe(route.source.y);
    expect(route.target.x - route.source.x).toBe(60);
  });

  it('keeps explicit pins fixed, and makes an old loop short when auto attachment is requested', () => {
    const original = nearbyServicesDocument(true);
    const edge = original.edges[0]!;
    const pinned = connectorRoutes(edge, original, 'transient')!.request;
    expect(pinned.source.side).toBe('bottom');
    expect(pinned.target.side).toBe('top');
    const free = autoAttachEnds(original, new Set([edge.id]), 'both');
    const route = connectorRoutes(free.edges[0]!, free, 'transient')!.request;
    expect(route.source.side).toBe('right');
    expect(route.target.side).toBe('left');
    expect(route.source.y).toBe(route.target.y);
    expect(free.edges[0]!.label).toBe(edge.label);
    expect(free.nodes).toBe(original.nodes);
  });

  it('follows a moved shape onto its new closest sides', () => {
    const document = nearbyServicesDocument();
    document.nodes[1] = { ...document.nodes[1]!, x: -410 };
    const route = connectorRoutes(document.edges[0]!, document, 'transient')!.request;
    expect(route.source.side).toBe('left');
    expect(route.target.side).toBe('right');
    expect(route.source.y).toBe(route.target.y);
  });

  it('slides a blocked automatic approach to the nearest clear point on the same side', () => {
    const document = nearbyServicesDocument();
    const route = connectorRoutes(document.edges[1]!, document, 'transient')!.request;
    expect(route.status).toBe('clear');
    expect(route.target.side).toBe('left');
    expect(route.target.y).toBe(25);
    expect(route.work).toBeLessThanOrEqual(2000);
  });

  it('does not slide a pinned approach or spend work after the shared search budget is disabled', () => {
    const document = nearbyServicesDocument();
    const source = rectOf(document.nodes[0]!);
    const target = rectOf(document.nodes[2]!);
    const options = { obstacles: [rectOf(document.nodes[1]!)] };
    const pinned = routeBetween(source, target, 'smoothstep', { ...options, anchors: { target: { side: 'left', offset: 0.5 } } });
    expect(pinned.target.y).toBe(67);
    const disabled = routeBetween(source, target, 'smoothstep', { ...options, fallback: false });
    expect(disabled.target.y).toBe(67);
    expect(disabled.work).toBe(0);
  });

  it('keeps manual bend geometry and pins intact', () => {
    const document = nearbyServicesDocument(true);
    const source = rectOf(document.nodes[0]!);
    const target = rectOf(document.nodes[1]!);
    const edge = document.edges[0]!;
    const route = routeBetween(source, target, 'smoothstep', { anchors: { source: edge.sourceAnchor, target: edge.targetAnchor }, waypoints: [{ x: 175, y: 220 }, { x: 585, y: -40 }] });
    expect(route.source.side).toBe('bottom');
    expect(route.target.side).toBe('top');
    expect(stepPolyline(route.d).some(p => p.y === 220)).toBe(true);
  });
});
