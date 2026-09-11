import { describe, expect, it } from 'vitest';
import { nearestInDirection, nextRelationshipNeighbor } from '../src/canvas/spatialNav';
import type { DraftEdge, DraftNode } from '../src/document/types';

function node(id: string, x: number, y: number, width = 100, height = 60): DraftNode {
  return { id, type: 'service', x, y, width, height, z: 0 };
}

function edge(id: string, source: string, target: string): DraftEdge {
  return { id, source, target, directed: true, routing: 'smoothstep' };
}

describe('nearestInDirection', () => {
  // A simple cross layout around the origin, spaced far enough apart that direction/alignment
  // scoring isn't ambiguous.
  const origin = { x: 0, y: 0 };
  const right = node('right', 300, -30);
  const left = node('left', -400, -30);
  const down = node('down', -50, 300);
  const up = node('up', -50, -400);
  const nodes = [right, left, down, up];

  it('picks the node to the right', () => {
    expect(nearestInDirection(nodes, origin, 'right')).toBe('right');
  });

  it('picks the node to the left', () => {
    expect(nearestInDirection(nodes, origin, 'left')).toBe('left');
  });

  it('picks the node below', () => {
    expect(nearestInDirection(nodes, origin, 'down')).toBe('down');
  });

  it('picks the node above', () => {
    expect(nearestInDirection(nodes, origin, 'up')).toBe('up');
  });

  it('prefers a further but well-aligned node over a closer, off-axis one', () => {
    const aligned = node('aligned', 400, 0, 20, 20);
    const closerButOffAxis = node('off-axis', 150, 250, 20, 20);
    const result = nearestInDirection([aligned, closerButOffAxis], origin, 'right');
    expect(result).toBe('aligned');
  });

  it('never picks a node behind the origin on the requested axis', () => {
    const behind = node('behind', -300, 0);
    expect(nearestInDirection([behind], origin, 'right')).toBeNull();
  });

  it('returns null when nothing is in that direction', () => {
    expect(nearestInDirection([], origin, 'right')).toBeNull();
  });

  it('excludes the given id even if it would otherwise be the best match', () => {
    expect(nearestInDirection(nodes, origin, 'right', 'right')).not.toBe('right');
  });
});

describe('nextRelationshipNeighbor', () => {
  const document = {
    edges: [edge('e1', 'a', 'b'), edge('e2', 'a', 'c'), edge('e3', 'd', 'a')],
  };

  it('returns the first outgoing neighbor when nothing is currently highlighted', () => {
    expect(nextRelationshipNeighbor(document, 'a', 'outgoing')).toBe('b');
  });

  it('cycles to the next outgoing neighbor on repeated calls', () => {
    expect(nextRelationshipNeighbor(document, 'a', 'outgoing', 'b')).toBe('c');
  });

  it('wraps back to the first outgoing neighbor after the last', () => {
    expect(nextRelationshipNeighbor(document, 'a', 'outgoing', 'c')).toBe('b');
  });

  it('returns the incoming neighbor, a different edge set than outgoing', () => {
    expect(nextRelationshipNeighbor(document, 'a', 'incoming')).toBe('d');
  });

  it('returns null when the node has no neighbors in that direction', () => {
    expect(nextRelationshipNeighbor(document, 'b', 'outgoing')).toBeNull();
  });

  it('starts over from the first neighbor if the given "after" id is no longer connected', () => {
    expect(nextRelationshipNeighbor(document, 'a', 'outgoing', 'not-a-real-neighbor')).toBe('b');
  });
});
