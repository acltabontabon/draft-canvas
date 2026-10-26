import { describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import { computeEdgeRoutes } from '../src/edges/edgeRoutes';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { routingPlan } from '../src/edges/bundles';
import { sharedRun } from '../src/agent/route';
import { labelChipSide, rectOf, responseAwayAt, sideSpan } from '../src/edges/routing';
import { stepPolyline } from '../src/edges/waypoints';
import { connectorStyleDocument } from './fixtures/connectors/checkout';

const rotate = (rect: { x: number; y: number; width: number; height: number }) => ({ x: -rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width });

describe('the checkout arrow regression', () => {
  it('keeps independently named API calls on distinct exits rather than one apparent junction', () => {
    const doc = connectorStyleDocument();
    const plan = routingPlan(doc.nodes, doc.edges, 'transient');
    expect(plan.spineFor('create')).toBeUndefined();
    expect(plan.spineFor('audit-call')).toBeUndefined();
    const create = connectorRoutes(doc.edges.find((e) => e.id === 'create')!, doc, 'transient')!.request;
    const audit = connectorRoutes(doc.edges.find((e) => e.id === 'audit-call')!, doc, 'transient')!.request;
    expect(Math.abs(create.source.y - audit.source.y)).toBeGreaterThanOrEqual(8);
    expect(sharedRun(stepPolyline(create.d), stepPolyline(audit.d))).toBeLessThan(8);
  });

  it('draws a straight line to the ledger glyph by moving the available automatic source end', () => {
    const doc = connectorStyleDocument();
    const route = connectorRoutes(doc.edges.find((e) => e.id === 'record')!, doc, 'transient')!.request;
    expect(new Set(stepPolyline(route.d).map((p) => p.y)).size).toBe(1);
    const glyph = rectOf(doc.nodes.find((n) => n.id === 'ledger')!);
    const span = sideSpan(glyph, 'left');
    expect(route.target.x).toBe(glyph.anchorBand!.left);
    expect(route.target.y).toBeGreaterThan(span.start);
    expect(route.target.y).toBeLessThan(span.start + span.length);
  });

  it('retains an intentional jog when both ends are pinned', () => {
    const doc = connectorStyleDocument();
    const edge = { ...doc.edges.find((e) => e.id === 'record')!, sourceAnchor: { side: 'right' as const, offset: 0.5 }, targetAnchor: { side: 'left' as const, offset: 0.5 } };
    const edges = doc.edges.map((e) => e.id === edge.id ? edge : e);
    const route = connectorRoutes(edge, { ...doc, edges }, 'transient')!.request;
    expect(route.source.y).toBe(410);
    expect(new Set(stepPolyline(route.d).map((p) => p.y)).size).toBeGreaterThan(1);
  });
});

describe.each([0, 1, 2, 3])('request/reply rails rotated %s quarter turns', (turns) => {
  it.each([-0.5, 0, 0.5])('keeps the middle runs separate and captions outside for lane %s', (lane) => {
    let a = { x: 250, y: 210, width: 160, height: 80 };
    let b = { x: 535, y: 370, width: 160, height: 80 };
    for (let i = 0; i < turns; i += 1) { a = rotate(a); b = rotate(b); }
    const nodes = [createNode({ id: 'a', type: 'service', ...a }), createNode({ id: 'b', type: 'service', ...b })];
    const routed = computeEdgeRoutes({
      source: rectOf(nodes[0]!), target: rectOf(nodes[1]!), routing: 'smoothstep',
      label: 'Request', sourceAnchor: undefined, targetAnchor: undefined,
      hasResponse: true, lane, spine: undefined, obstacles: [], waypoints: undefined,
    });
    const request = stepPolyline(routed.request.d);
    const response = stepPolyline(routed.response!.d);
    expect(sharedRun(request, response)).toBeLessThan(8);
    const away = responseAwayAt(routed.request, routed.response, lane);
    const side = labelChipSide(routed.request.labelSide, away);
    expect(side).not.toBe(routed.responseLabel!.side);
    expect(routed.request.status).toBe('clear');
    expect(routed.response!.status).toBe('clear');
  });
});
