import { describe, expect, it } from 'vitest';
import { relaxLayoutAnchors } from '../../src/agent/route';
import { connectorRoutes } from '../../src/edges/connectorRoutes';
import { createEdge, createNode } from '../../src/document/factory';
import type { DraftEdge, DraftNode } from '../../src/document/types';

/**
 * A diagram an agent drew kept most of its connector ends pinned: the layout chose a handle, an
 * automatic end would sit a few pixels along the side from it, and anything but the very same picture
 * kept the pin. A pinned end does not follow its shape when a person moves it. Authoring now lets a
 * pin go wherever the line reads no worse without it.
 */
const box = (id: string, x: number, y: number): DraftNode => ({ ...createNode({ id, type: 'service', x, y, text: id }), width: 176, height: 68 });
const line = (id: string, source: string, target: string, anchors: Partial<DraftEdge>): DraftEdge => ({ ...createEdge({ id, source, target }), ...anchors });
const pinnedEnds = (edges: readonly DraftEdge[]) => edges.reduce((count, e) => count + (e.sourceAnchor ? 1 : 0) + (e.targetAnchor ? 1 : 0), 0);
const bends = (edge: DraftEdge, nodes: DraftNode[], edges: DraftEdge[]) => (connectorRoutes(edge, { nodes, edges }, 'transient')!.request.d.match(/Q/g) ?? []).length;

describe('letting go of the pins a layout chose', () => {
  const nodes = [box('a', 0, 0), box('b', 400, 0)];
  // Straight across, a quarter of the way down both sides: an automatic end runs the same straight
  // line through the middle of both.
  const quarter = line('ab', 'a', 'b', { sourceAnchor: { side: 'right', offset: 0.25 }, targetAnchor: { side: 'left', offset: 0.25 } });

  it('keeps them where only the very same picture will do', () => {
    const { edges, kept } = relaxLayoutAnchors(new Set(['ab']), nodes, [quarter]);
    expect(pinnedEnds(edges)).toBe(2);
    expect(kept.map((pin) => pin.end).sort()).toEqual(['source', 'target']);
  });

  it('lets them go when authoring, for a line that reads no worse', () => {
    const { edges, kept } = relaxLayoutAnchors(new Set(['ab']), nodes, [quarter], new Set(), { polish: true });
    expect(pinnedEnds(edges)).toBe(0);
    expect(kept).toEqual([]);
    expect(bends(edges[0]!, nodes, edges)).toBe(0);
  });

  it('never lets go of an end the agent placed itself', () => {
    // The source was asked for: it stays. The target follows it, straightening onto the line the
    // pinned end draws, so the picture is the one that was asked for.
    const { edges, kept } = relaxLayoutAnchors(new Set(['ab']), nodes, [quarter], new Set(['ab:source']), { polish: true });
    expect(edges[0]!.sourceAnchor).toEqual({ side: 'right', offset: 0.25 });
    expect(edges[0]!.targetAnchor).toBeUndefined();
    expect(kept).toEqual([]);
    expect(bends(edges[0]!, nodes, edges)).toBe(0);
  });

  it('keeps a pin whose line would bend without it', () => {
    // B stands half a box lower, and the layout ran the line straight between the bottom quarter of
    // A and the top quarter of B. Left to itself the line would step down between their middles.
    const lower = [box('a', 0, 0), box('b', 400, 34)];
    const level = line('ab', 'a', 'b', { sourceAnchor: { side: 'right', offset: 0.75 }, targetAnchor: { side: 'left', offset: 0.25 } });
    expect(bends(level, lower, [level])).toBe(0);
    const { edges } = relaxLayoutAnchors(new Set(['ab']), lower, [level], new Set(), { polish: true });
    expect(bends(edges[0]!, lower, edges)).toBe(0);
  });

  it('never touches a connector the operation did not draw', () => {
    const { edges } = relaxLayoutAnchors(new Set(), nodes, [quarter], new Set(), { polish: true });
    expect(edges[0]).toEqual(quarter);
  });
});
