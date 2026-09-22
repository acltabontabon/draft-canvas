import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import type { DraftEdge, DraftNode } from '../src/document/types';
import { labelGroupPlan, labelLeader } from '../src/edges/labelGroups';
import { flattenPath, rectOf, routeBetween } from '../src/edges/routing';
import { renderDocumentSvg } from '../src/render/svg/document';

/**
 * One label for connectors that leave together (`edges/labelGroups.ts`) — which connectors count,
 * where the label goes, and every case that must keep the labels apart. Presentation only: none of
 * these ever changes an edge.
 */

const service = (id: string, x: number, y: number) => createNode({ id, type: 'service', x, y, width: 160, height: 80 });

/**
 * A shape on the left and targets to its right, one per `ys` entry. With the targets level with each
 * other their routes run as one line out of the source's right side until the elbow, then part.
 */
function branches(ys: number[], edge: (index: number) => Partial<DraftEdge> = () => ({ label: 'Pay Credit Card' }), targetX = 640) {
  const nodes: DraftNode[] = [service('pay', 0, 300), ...ys.map((y, i) => service(`t${i}`, targetX, y))];
  const edges: DraftEdge[] = ys.map((_, i) => ({ ...createEdge({ id: `e${i}`, source: 'pay', target: `t${i}` }), ...edge(i) }));
  return { nodes, edges };
}

describe('connectors sharing a label', () => {
  it('two branches that leave together share one label, on the run they share', () => {
    const { nodes, edges } = branches([40, 560]);
    const plan = labelGroupPlan(nodes, edges);
    const group = plan.groupFor('e0');
    expect(group).toBeDefined();
    expect(plan.groupFor('e1')).toBe(group);
    expect(group!.members).toEqual(['e0', 'e1']);
    // On the horizontal run out of the source's right side (y = its middle), clear of the shape and
    // of the elbow where the two turn apart, and on the line itself.
    expect(group!.y).toBe(340);
    expect(group!.x).toBeGreaterThan(160 + 14);
    const elbow = Math.min(...edges.map((edge) => sharedRunEnd(nodes, edge)));
    expect(group!.x).toBeLessThan(elbow - 14);
    expect(['top', 'bottom']).toContain(group!.side);
    // The edges themselves are untouched.
    expect(edges.every((edge) => edge.label === 'Pay Credit Card')).toBe(true);
  });

  it('three or more branches share one label too', () => {
    const { nodes, edges } = branches([0, 300, 600]);
    const group = labelGroupPlan(nodes, edges).groupFor('e0');
    expect(group?.members).toHaveLength(3);
    expect(new Set(edges.map((edge) => labelGroupPlan(nodes, edges).groupFor(edge.id)))).toEqual(new Set([group]));
  });

  it('differently labelled branches keep their own labels', () => {
    const { nodes, edges } = branches([40, 560], (i) => ({ label: i === 0 ? 'Pay Credit Card' : 'Pay Invoice' }));
    expect(labelGroupPlan(nodes, edges).groupFor('e0')).toBeUndefined();
  });

  it('a differently labelled or unlabelled connector on the same stretch keeps every label apart', () => {
    for (const third of [{ label: 'Refund' }, { label: undefined }]) {
      const { nodes, edges } = branches([40, 560, 300], (i) => (i < 2 ? { label: 'Pay Credit Card' } : third));
      // The third leaves the same side and runs along the same line — the label would seem to be its.
      expect(labelGroupPlan(nodes, edges).groupFor('e0'), JSON.stringify(third)).toBeUndefined();
    }
  });

  it('connectors leaving by different sides are not a group, however alike', () => {
    const nodes = [service('pay', 400, 300), service('left', 0, 300), service('right', 800, 300)];
    const edges = [
      createEdge({ id: 'l', source: 'pay', target: 'left', label: 'Pay Credit Card' }),
      createEdge({ id: 'r', source: 'pay', target: 'right', label: 'Pay Credit Card' }),
    ];
    expect(labelGroupPlan(nodes, edges).groupFor('l')).toBeUndefined();
  });

  it('a shared run too short for the label keeps the labels apart', () => {
    // Targets just past the source: the lines part almost as soon as they leave it.
    const { nodes, edges } = branches([40, 560], () => ({ label: 'Pay Credit Card' }), 230);
    expect(labelGroupPlan(nodes, edges).groupFor('e0')).toBeUndefined();
  });

  it('only connectors that look and mean the same share a label', () => {
    for (const odd of [{ async: true }, { kind: 'event' as const }, { accent: 'amber' as const }, { directed: false }, { routing: 'bezier' as const }]) {
      const { nodes, edges } = branches([40, 560], (i) => ({ label: 'Pay Credit Card', ...(i === 1 ? odd : {}) }));
      expect(labelGroupPlan(nodes, edges).groupFor('e0'), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it('a connector carrying a condition, a reply or attachments keeps its own label', () => {
    for (const odd of [{ condition: 'approved' }, { hasResponse: true }]) {
      const { nodes, edges } = branches([40, 560], (i) => ({ label: 'Pay Credit Card', ...(i === 1 ? odd : {}) }));
      expect(labelGroupPlan(nodes, edges).groupFor('e0'), JSON.stringify(odd)).toBeUndefined();
    }
  });

  it('a connector whose label changes leaves the group at once', () => {
    const { nodes, edges } = branches([40, 560]);
    expect(labelGroupPlan(nodes, edges).groupFor('e0')).toBeDefined();
    const edited = edges.map((edge) => (edge.id === 'e1' ? { ...edge, label: 'Pay Credit Card (retry)' } : edge));
    expect(labelGroupPlan(nodes, edited).groupFor('e0')).toBeUndefined();
    expect(labelGroupPlan(nodes, edited).groupFor('e1')).toBeUndefined();
  });

  it('moving a target so the lines no longer leave together splits the group', () => {
    const { nodes, edges } = branches([40, 560]);
    // One target now level with the source: its connector runs straight across, the other's turns off
    // at its own elbow — they still leave together, so they still share...
    const level = nodes.map((node) => (node.id === 't1' ? { ...node, y: 300 } : node));
    expect(labelGroupPlan(level, edges).groupFor('e0')).toBeDefined();
    // ...but one moved behind the source leaves by the other side, and shares nothing.
    const behind = nodes.map((node) => (node.id === 't1' ? { ...node, x: -700 } : node));
    expect(labelGroupPlan(behind, edges).groupFor('e0')).toBeUndefined();
  });

  it('is cached on the arrays, and an edit that moves nothing keeps each group the same object', () => {
    const { nodes, edges } = branches([40, 560]);
    const plan = labelGroupPlan(nodes, edges);
    expect(labelGroupPlan(nodes, edges)).toBe(plan);
    const renamed = nodes.map((node) => (node.id === 't0' ? { ...node, text: 'Stripe' } : node));
    expect(labelGroupPlan(renamed, edges).groupFor('e0')).toBe(plan.groupFor('e0'));
  });

  it('the member drawing the label is the selected one, then the step being presented, then the first', () => {
    const { nodes, edges } = branches([40, 560]);
    const group = labelGroupPlan(nodes, edges).groupFor('e0')!;
    expect(labelLeader(group, { selectedEdges: [] })).toBe('e0');
    expect(labelLeader(group, { selectedEdges: ['e1'] })).toBe('e1');
    expect(labelLeader(group, { selectedEdges: [], tierOf: (id) => (id === 'e1' ? 'active' : 'hidden') })).toBe('e1');
  });
});

describe('a shared label in an export', () => {
  const documentOf = (ys: number[]) => {
    const { nodes, edges } = branches(ys);
    return { ...createDocument('Payments'), nodes, edges };
  };
  const count = (svg: string) => svg.split('Pay Credit Card').length - 1;

  it('is drawn once where the canvas draws it, for two branches or three', () => {
    expect(count(renderDocumentSvg(documentOf([40, 560])).svg)).toBe(1);
    expect(count(renderDocumentSvg(documentOf([0, 300, 600])).svg)).toBe(1);
  });

  it('leaves each connector its own label when they are not a group', () => {
    const document = documentOf([40, 560]);
    document.edges[1] = { ...document.edges[1]!, label: 'Pay Invoice' };
    const svg = renderDocumentSvg(document).svg;
    expect(count(svg)).toBe(1);
    expect(svg).toContain('Pay Invoice');
  });

  it('keeps every label in the saved document', () => {
    const document = documentOf([40, 560]);
    renderDocumentSvg(document);
    expect(document.edges.map((edge) => edge.label)).toEqual(['Pay Credit Card', 'Pay Credit Card']);
  });
});

/** Where an edge's route first turns, along x — the far end of the run out of the source. */
function sharedRunEnd(nodes: DraftNode[], edge: DraftEdge): number {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const route = routeBetween(rectOf(byId.get(edge.source)!), rectOf(byId.get(edge.target)!), edge.routing, {});
  const points = flattenPath(route.d);
  const turn = points.findIndex((point, i) => i > 0 && Math.abs(point.y - points[0]!.y) > 0.5);
  return points[Math.max(0, turn - 1)]!.x;
}
