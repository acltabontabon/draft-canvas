import { describe, expect, it } from 'vitest';
import { agentGhostDiff, movedShapes } from '../src/canvas/agentGhostDiff';
import { createEdge, createNode } from '../src/document/factory';
import type { DraftNode } from '../src/document/types';

describe('agentGhostDiff', () => {
  it('buckets an added node separately from an added group', () => {
    const before = { nodes: [], edges: [] };
    const node = createNode({ type: 'service', x: 0, y: 0 });
    const group = createNode({ type: 'group', x: 0, y: 0 });
    const after = { nodes: [node, group], edges: [] };

    const diff = agentGhostDiff(before, after);
    expect(diff.addedNodes).toEqual([node]);
    expect(diff.addedGroups).toEqual([group]);
    expect(diff.modifiedNodes).toEqual([]);
    expect(diff.removedNodes).toEqual([]);
  });

  it('flags a moved or renamed node as modified, not added or removed', () => {
    const node = createNode({ id: 'n1', type: 'service', x: 0, y: 0, text: 'Old' });
    const moved = { ...node, x: 40 };
    const diff = agentGhostDiff({ nodes: [node], edges: [] }, { nodes: [moved], edges: [] });
    expect(diff.modifiedNodes).toEqual([moved]);
    expect(diff.addedNodes).toEqual([]);
    expect(diff.removedNodes).toEqual([]);
  });

  it('flags a reparent (group membership change) as modified, even with no geometry change', () => {
    // Regression: `nodeChanged` once checked only geometry/text/type, so a node moved into a
    // different group (no position/size/label change) showed as "modified" in the text diff
    // (`diffForReview`'s `nodeFields` includes `group`) but nowhere on the canvas ghost.
    const node = createNode({ id: 'n1', type: 'service', x: 0, y: 0 });
    const reparented = { ...node, parentId: 'g1' };
    const diff = agentGhostDiff({ nodes: [node], edges: [] }, { nodes: [reparented], edges: [] });
    expect(diff.modifiedNodes).toEqual([reparented]);
  });

  it('flags a description or technology change as modified, since both are drawn on the shape', () => {
    const node = createNode({ id: 'n1', type: 'service', x: 0, y: 0 });
    const described = { ...node, description: 'Handles checkout.' };
    expect(agentGhostDiff({ nodes: [node], edges: [] }, { nodes: [described], edges: [] }).modifiedNodes).toEqual([described]);
    const withTech = { ...node, technology: 'Spring Boot' };
    expect(agentGhostDiff({ nodes: [node], edges: [] }, { nodes: [withTech], edges: [] }).modifiedNodes).toEqual([withTech]);
  });

  it.each<Partial<DraftNode>>([
    { annotation: true },
    { textRole: 'heading' },
    { textFont: 'serif' },
    { textBackground: 'marker' },
    { textAlign: 'right' },
    { textBold: true },
    { textItalic: true },
  ])('previews label styling even when its geometry stays unchanged: %j', (style) => {
    const node = createNode({ id: 'label', type: 'text', x: 0, y: 0, text: 'A long heading\nshort' });
    const styled = { ...node, ...style };
    expect(agentGhostDiff({ nodes: [node], edges: [] }, { nodes: [styled], edges: [] }).modifiedNodes).toEqual([styled]);
    expect(agentGhostDiff({ nodes: [styled], edges: [] }, { nodes: [node], edges: [] }).modifiedNodes).toEqual([node]);
  });

  it('leaves an untouched node out of every bucket', () => {
    const node = createNode({ id: 'n1', type: 'service', x: 0, y: 0 });
    const diff = agentGhostDiff({ nodes: [node], edges: [] }, { nodes: [node], edges: [] });
    expect(diff.addedNodes).toEqual([]);
    expect(diff.modifiedNodes).toEqual([]);
    expect(diff.removedNodes).toEqual([]);
  });

  it('flags a removed group separately from a removed plain node', () => {
    const node = createNode({ id: 'n1', type: 'service', x: 0, y: 0 });
    const group = createNode({ id: 'g1', type: 'group', x: 0, y: 0 });
    const diff = agentGhostDiff({ nodes: [node, group], edges: [] }, { nodes: [], edges: [] });
    expect(diff.removedNodes).toEqual([node]);
    expect(diff.removedGroups).toEqual([group]);
  });

  it('flags an added and a removed edge', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'service', x: 200, y: 0 });
    const edge = createEdge({ id: 'e1', source: 'a', target: 'b' });
    const before = { nodes: [a, b], edges: [edge] };
    const after = { nodes: [a, b], edges: [] };
    const diff = agentGhostDiff(before, after);
    expect(diff.removedEdges).toEqual([edge]);
    expect(diff.addedEdges).toEqual([]);
  });

  it('flags an edge rewired to a different target as modified, not unchanged', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'service', x: 200, y: 0 });
    const c = createNode({ id: 'c', type: 'service', x: 400, y: 0 });
    const edge = createEdge({ id: 'e1', source: 'a', target: 'b' });
    const rewired = { ...edge, target: 'c' };
    const diff = agentGhostDiff({ nodes: [a, b, c], edges: [edge] }, { nodes: [a, b, c], edges: [rewired] });
    expect(diff.modifiedEdges).toEqual([rewired]);
  });

  it('flags a semantic-only change (no label/anchor change) as modified', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'service', x: 200, y: 0 });
    const edge = createEdge({ id: 'e1', source: 'a', target: 'b' });
    const changed = { ...edge, semantic: 'command' as const };
    const diff = agentGhostDiff({ nodes: [a, b], edges: [edge] }, { nodes: [a, b], edges: [changed] });
    expect(diff.modifiedEdges).toEqual([changed]);
  });

  it('leaves an untouched edge out of every bucket', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'service', x: 200, y: 0 });
    const edge = createEdge({ id: 'e1', source: 'a', target: 'b' });
    const diff = agentGhostDiff({ nodes: [a, b], edges: [edge] }, { nodes: [a, b], edges: [edge] });
    expect(diff.addedEdges).toEqual([]);
    expect(diff.modifiedEdges).toEqual([]);
    expect(diff.removedEdges).toEqual([]);
  });
});

describe('movedShapes', () => {
  it('names the shapes a change moves or resizes, with where they stand now', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    const b = createNode({ id: 'b', type: 'service', x: 200, y: 0 });
    const added = createNode({ id: 'c', type: 'service', x: 400, y: 0 });
    const moved = movedShapes(
      { nodes: [a, b], edges: [] },
      { nodes: [{ ...a, text: 'Renamed' }, { ...b, x: 260 }, added], edges: [] },
    );
    expect(moved.map((m) => [m.node.id, m.from.x, m.node.x])).toEqual([['b', 200, 260]]);
  });

  it('leaves out a boundary growing to fit, and a box growing with its label', () => {
    const group = createNode({ id: 'g', type: 'group', x: 0, y: 0, width: 300, height: 200 });
    const a = createNode({ id: 'a', type: 'service', x: 20, y: 40 });
    const after = [{ ...group, width: 420, height: 260 }, { ...a, width: a.width + 40 }];
    expect(movedShapes({ nodes: [group, a], edges: [] }, { nodes: after, edges: [] })).toEqual([]);
  });

  it('is empty for a change that only adds or relabels', () => {
    const a = createNode({ id: 'a', type: 'service', x: 0, y: 0 });
    expect(movedShapes({ nodes: [a], edges: [] }, { nodes: [{ ...a, text: 'New name' }], edges: [] })).toEqual([]);
  });
});
