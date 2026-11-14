import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../../src/document/factory';
import type { DraftEdge, DraftNode } from '../../src/document/types';
import { snapLevelJogs } from '../../src/agent/place';

/**
 * The last straightening of a layout nudges a shape sideways to meet its neighbour's line. It used to
 * keep clear of shapes and the notes beside them, but not of a boundary's heading note, which the
 * layout places like a shape: on a 350-shape diagram laid out down, a 200 px Text ("Answers
 * questions, changes nothing") ended up over "Query API", by as much as the nudge.
 */
describe('snapping a jog out of a connector', () => {
  const node = (id: string, type: DraftNode['type'], x: number, y: number, width: number, height: number, extra: Partial<DraftNode> = {}): DraftNode =>
    ({ ...createNode({ type, x, y, width, height, text: id }), id, ...extra });

  function scene() {
    const group = node('g', 'group', 1000, 3500, 700, 320);
    // The heading note, placed by the layout first in its row; the API 12 px to its right.
    const heading = node('h', 'text', 1098, 3611, 200, 24, { parentId: 'g' });
    const api = node('api', 'service', 1310, 3611, 176, 68, { parentId: 'g' });
    // A caller above and 40 px to the left: its connector comes down 40 px out of line with the API.
    const caller = node('c', 'service', 1270, 3300, 176, 68);
    const edge: DraftEdge = { ...createEdge({ id: 'e', source: 'c', target: 'api' }), sourceAnchor: { side: 'bottom', offset: 0.5 }, targetAnchor: { side: 'top', offset: 0.5 } };
    return {
      edges: [edge],
      elements: new Map([api, caller].map((n) => [n.id, n])),
      groups: new Map([[group.id, group]]),
      memberNotes: new Map([[heading.id, heading]]),
      api,
      heading,
    };
  }

  it('keeps clear of the heading note beside the shape it moves', () => {
    const { edges, elements, groups, memberNotes, api, heading } = scene();
    snapLevelJogs(edges, elements, groups, 72, new Map(), memberNotes);
    const overlap = Math.min(heading.x + heading.width, api.x + api.width) - Math.max(heading.x, api.x);
    // Not moved onto it: the jog stays rather than the heading being run over.
    expect(overlap).toBeLessThanOrEqual(0);
    expect(api.x).toBe(1310);
  });

  it('still straightens the connector where nothing is in the way', () => {
    const { edges, elements, groups, api } = scene();
    snapLevelJogs(edges, elements, groups, 72, new Map(), new Map());
    // 40 px to the left, to meet the caller's line: what the heading note used to be run over for.
    expect(api.x).toBe(1270);
  });
});
