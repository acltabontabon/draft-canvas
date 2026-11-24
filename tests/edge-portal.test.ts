import { describe, expect, it } from 'vitest';
import { legibilityOf } from '../src/agent/legibility';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { parseDocument } from '../src/document/validate';
import { crossingPlan } from '../src/edges/crossings';
import { PORTAL_RING, PORTAL_STUB, portalName, portalOf, portalWordsRect } from '../src/edges/portal';
import { renderDocumentSvg } from '../src/render/svg/document';

const route = { source: { x: 100, y: 50, side: 'right' as const }, target: { x: 900, y: 400, side: 'top' as const } };

describe('a connector drawn as a portal', () => {
  it('leaves its source and arrives at its target on the sides the line would, with nothing between', () => {
    const portal = portalOf(route, { directed: true }, { source: 'Checkout', target: 'Billing' });
    expect(portal.out.line).toBe(`M100 50L${100 + PORTAL_STUB} 50`);
    expect(portal.into.line).toBe(`M900 ${400 - PORTAL_STUB}L900 400`);
    // One path, the arriving stub last: an arrowhead at its end lands on the target.
    expect(portal.d).toBe(`${portal.out.line}${portal.into.line}`);
    expect(portal.out.ring).toEqual({ x: 100 + PORTAL_STUB + PORTAL_RING, y: 50 });
    expect(portal.into.ring).toEqual({ x: 900, y: 400 - PORTAL_STUB - PORTAL_RING });
  });

  it('says where it goes at one end and where it came from at the other', () => {
    const portal = portalOf(route, { directed: true, label: 'charges' }, { source: 'Checkout', target: 'Billing' });
    expect(portal.out.text).toBe('→ Billing · charges');
    expect(portal.into.text).toBe('Checkout →');
    expect(portalOf(route, { directed: false }, { source: 'A', target: 'B' }).out.text).toBe('– B');
    expect(portalName({ text: '' })).toBe('shape');
    expect(portalName({ text: 'A very long name for a service that goes on' }).length).toBeLessThanOrEqual(26);
  });

  it('puts its words beyond the ring, away from the shape, on every side', () => {
    const portal = portalOf(route, { directed: true }, { source: 'A', target: 'B' });
    const out = portalWordsRect(portal.out, 60, 16);
    expect(out.left).toBeGreaterThan(portal.out.ring.x + PORTAL_RING);
    expect(out.top + 8).toBe(50);
    const into = portalWordsRect(portal.into, 60, 16);
    expect(into.top + 16).toBeLessThan(portal.into.ring.y - PORTAL_RING);
    expect(into.left + 30).toBe(900);
  });

  function crossed(portal: boolean) {
    // One line across, one line down through the middle of it.
    const at: Array<[string, number, number]> = [['a', 0, 0], ['b', 700, 0], ['c', 350, -320], ['d', 350, 320]];
    const nodes = at.map(([id, x, y]) => createNode({ id, type: 'service', x, y, text: id.toUpperCase() }));
    const ab = { ...createEdge({ id: 'ab', source: 'a', target: 'b' }), ...(portal ? { portal: true } : {}) };
    const cd = createEdge({ id: 'cd', source: 'c', target: 'd' });
    return addEdges(addNodes(createDocument('Crossed'), nodes), [ab, cd]);
  }

  it('crosses nothing: the line it would have drawn is out of every count and every bridge', () => {
    const line = crossed(false);
    const portal = crossed(true);
    expect(legibilityOf(line.nodes, line.edges).crossings).toBe(1);
    expect(legibilityOf(portal.nodes, portal.edges).crossings).toBe(0);
    const plan = crossingPlan(portal.nodes, portal.edges, portal.nodes, 'transient');
    expect(plan.crossingsFor('ab')).toHaveLength(0);
    expect(plan.crossingsFor('cd')).toHaveLength(0);
  });

  it('survives a save and a load, and exports as two stubs and their words', () => {
    const doc = crossed(true);
    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.document.edges.find((e) => e.id === 'ab')!.portal).toBe(true);
    expect('portal' in parsed.document.edges.find((e) => e.id === 'cd')!).toBe(false);
    const svg = renderDocumentSvg(doc, { theme: 'light' } as Parameters<typeof renderDocumentSvg>[1]).svg;
    expect(svg).toContain('→ B');
    expect(svg).toContain('A →');
  });
});

describe('where a portal sits on its shape', () => {
  it('takes the side facing where it goes when that side is free, and another when a real line uses it', async () => {
    const { portalPlan } = await import('../src/edges/portalPlan');
    const { slotPoint } = await import('../src/edges/portal');
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'A' });
    const b = createNode({ id: 'b', type: 'service', x: 400, y: 0, text: 'B' });
    const c = createNode({ id: 'c', type: 'service', x: 1600, y: 0, text: 'C' });
    const line = createEdge({ id: 'ab', source: 'a', target: 'b' });
    const far = { ...createEdge({ id: 'ac', source: 'a', target: 'c' }), portal: true };
    const again = { ...createEdge({ id: 'ca', source: 'c', target: 'a' }), portal: true };
    const doc = addEdges(addNodes(createDocument('Seats'), [a, b, c]), [line, far, again]);
    const plan = portalPlan(doc.nodes, doc.edges);
    // A's right side carries the real line to B: the portal to C takes the top instead.
    expect(plan.slotsFor('ac')!.source).toEqual({ side: 'top', shift: 0 });
    // C's left side is free, so the portal arrives where a line would.
    expect(plan.slotsFor('ac')!.target).toEqual({ side: 'left', shift: 0 });
    // A second portal on the same side of the same shape sits a step along it, not on top.
    expect(plan.slotsFor('ca')!.source.side).toBe('left');
    expect(plan.slotsFor('ca')!.source.shift).not.toBe(0);
    expect(plan.slotsFor('ab')).toBeUndefined();
    expect(slotPoint({ x: 0, y: 0, width: 100, height: 60 }, { side: 'top', shift: 10 })).toEqual({ x: 60, y: 0, side: 'top' });
    // The same arrays, the same plan object: nothing is worked out twice.
    expect(portalPlan(doc.nodes, doc.edges)).toBe(plan);
  });
});
