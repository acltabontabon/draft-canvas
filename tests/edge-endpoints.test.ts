import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import type { DraftEdge, DraftNode, EdgeAnchor, Side } from '../src/document/types';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { ENDPOINT_MIN_SPACING, endpointPlan } from '../src/edges/endpoints';
import { anchorPoint, rectOf, routeBetween } from '../src/edges/routing';

/**
 * Automatic ends that share a side of a shape are spread along it, in the order their far ends lie,
 * clear of what is fixed there — and a side with a single automatic end is left exactly as it was.
 */

const box = (id: string, x: number, y: number, width = 160, height = 80): DraftNode => createNode({ id, type: 'service', x, y, width, height });
const edge = (id: string, source: string, target: string, extra: Partial<DraftEdge> = {}): DraftEdge => createEdge({ id, source, target, ...extra });
const SEMANTICS = ['calls', 'writes', 'publishes', 'reads', 'query', 'command'] as const;

/** `n` connectors out of A's right side, each meaning something different, to shapes stacked on the right. */
function fan(n: number, height = 80, extra: (i: number) => Partial<DraftEdge> = () => ({})) {
  const nodes = [box('a', 0, 200, 160, height)];
  const edges: DraftEdge[] = [];
  for (let i = 0; i < n; i += 1) {
    nodes.push(box(`b${i}`, 500, i * 140));
    edges.push(edge(`e${i}`, 'a', `b${i}`, { semantic: SEMANTICS[i % SEMANTICS.length], ...extra(i) }));
  }
  return { nodes, edges };
}

/** Where each connector leaves A, along A's right side. */
function startsOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[]) {
  return edges.map((e) => connectorRoutes(e, { nodes, edges }, 'transient')!.request.source);
}

describe('spreading automatic ends along a side', () => {
  it('gives each its own point, in the order their far ends lie, so they leave without crossing', () => {
    const { nodes, edges } = fan(4);
    const starts = startsOf(nodes, edges);
    expect(starts.every((s) => s.side === 'right')).toBe(true);
    const ys = starts.map((s) => s.y);
    expect([...ys].sort((p, q) => p - q)).toEqual(ys);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(ENDPOINT_MIN_SPACING);
  });

  it('never moves a pinned end, and keeps the spread ones clear of it', () => {
    const pin: EdgeAnchor = { side: 'right', offset: 0.5 };
    const { nodes, edges } = fan(3, 120, (i) => (i === 1 ? { sourceAnchor: pin } : {}));
    const starts = startsOf(nodes, edges);
    const a = rectOf(nodes[0]!);
    expect(starts[1]!.y).toBeCloseTo(anchorPoint(a, 'right', 0.5).y);
    for (const i of [0, 2]) expect(Math.abs(starts[i]!.y - starts[1]!.y)).toBeGreaterThanOrEqual(ENDPOINT_MIN_SPACING);
  });

  it('leaves a side with one automatic end to the router, exactly as before', () => {
    const { nodes, edges } = fan(1);
    expect(endpointPlan(nodes, edges, 'transient').spreadFor('e0')).toBeUndefined();
  });

  it('keeps a trunk\'s connectors on one shared point', () => {
    // Same meaning, far ends spread out: a fan-out trunk.
    const { nodes, edges } = fan(4, 80, () => ({ semantic: 'calls' }));
    const starts = startsOf(nodes, edges);
    expect(new Set(starts.map((s) => `${s.x},${s.y}`)).size).toBe(1);
  });

  it('makes room for a reply line beside its request', () => {
    const { nodes, edges } = fan(3, 120, (i) => (i === 0 ? { hasResponse: true } : {}));
    const routes = edges.map((e) => connectorRoutes(e, { nodes, edges }, 'transient')!);
    const reply = routes[0]!.response!.target;
    for (const i of [1, 2]) expect(Math.abs(routes[i]!.request.source.y - reply.y)).toBeGreaterThanOrEqual(ENDPOINT_MIN_SPACING);
  });

  it('shares points on a side too short for them, and says the side is crowded', () => {
    // A 20px-tall shape whose far shapes all sit level with it: no other side faces them.
    const nodes = [box('a', 0, 220, 160, 20)];
    const edges: DraftEdge[] = [];
    for (let i = 0; i < 5; i += 1) {
      nodes.push(box(`b${i}`, 400 + i * 200, 190));
      edges.push(edge(`e${i}`, 'a', `b${i}`, { semantic: SEMANTICS[i] }));
    }
    expect(endpointPlan(nodes, edges, 'transient').crowded).toEqual(['a:right']);
    expect(startsOf(nodes, edges).every((s) => s.side === 'right')).toBe(true);
  });

  it('hands a full side\'s outermost ends to the side facing their far ends', () => {
    // Six ends into a 60px side: room for four at most. The far shapes sit well above and below.
    const nodes = [box('a', 0, 400, 160, 60)];
    const edges: DraftEdge[] = [];
    for (let i = 0; i < 6; i += 1) {
      nodes.push(box(`b${i}`, 600, -200 + i * 250));
      edges.push(edge(`e${i}`, 'a', `b${i}`, { semantic: SEMANTICS[i] }));
    }
    const sides = startsOf(nodes, edges).map((s) => s.side);
    expect(sides.filter((side: Side) => side !== 'right').length).toBeGreaterThan(0);
    expect(sides).toContain('right');
  });

  it('straightens a spread end onto a level partner only when it keeps its room', () => {
    // Two connectors to shapes almost level with A's two spread points.
    const nodes = [box('a', 0, 200, 160, 120), box('b0', 500, 207), box('b1', 500, 247)];
    const edges = [edge('e0', 'a', 'b0', { semantic: 'calls' }), edge('e1', 'a', 'b1', { semantic: 'writes' })];
    const starts = startsOf(nodes, edges);
    expect(Math.abs(starts[1]!.y - starts[0]!.y)).toBeGreaterThanOrEqual(ENDPOINT_MIN_SPACING);
  });

  it('does not reorder a side\'s ends for a one-pixel move that changes no far end\'s order', () => {
    const { nodes, edges } = fan(4);
    const before = startsOf(nodes, edges).map((s) => s.y);
    const nudged = nodes.map((n) => (n.id === 'b2' ? { ...n, y: n.y + 1 } : n));
    const after = startsOf(nudged, edges).map((s) => s.y);
    const order = (ys: number[]) => ys.map((_, i) => i).sort((p, q) => ys[p]! - ys[q]!).join();
    expect(order(after)).toBe(order(before));
  });

  it('hands back the same spread object while nothing it depends on changes', () => {
    const { nodes, edges } = fan(3);
    const first = endpointPlan(nodes, edges).spreadFor('e1');
    const renamed = nodes.map((n) => (n.id === 'b0' ? { ...n, text: 'Renamed' } : n));
    expect(endpointPlan(renamed, edges).spreadFor('e1')).toBe(first);
  });

  it('keeps a planned side through a gesture until another side is clearly better', () => {
    // B up and to the right: by gaps the top side now wins, by only 10px — the planned right side holds
    // mid-drag, and the same shapes at rest go by the gaps.
    const a = { x: 0, y: 0, width: 160, height: 80 };
    const b = { x: 230, y: -160, width: 160, height: 80 };
    const spread = { source: { side: 'right' as Side, offset: 0.3 } };
    expect(routeBetween(a, b, 'smoothstep').source.side).toBe('top');
    expect(routeBetween(a, b, 'smoothstep', { spread, mode: 'gesture' }).source.side).toBe('right');
    // At rest, the plan is asked again; a far move in a gesture lets go of it.
    const far = routeBetween(a, { ...b, x: 100, y: -600 }, 'smoothstep', { spread, mode: 'gesture' });
    expect(far.source.side).toBe('top');
  });
});
