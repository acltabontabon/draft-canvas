import { describe, expect, it } from 'vitest';
import { agentGhostDiff } from '../src/canvas/agentGhostDiff';
import { createEdge, createNode } from '../src/document/factory';

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
