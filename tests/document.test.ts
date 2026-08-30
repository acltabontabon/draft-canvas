import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import {
  addEdges,
  addNodes,
  alignNodes,
  boundsOf,
  distributeNodes,
  extractFragment,
  moveNodes,
  pasteFragment,
  removeElements,
  setTitle,
  updateNode,
} from '../src/document/operations';
import { CURRENT_VERSION, DRAFT_FORMAT } from '../src/document/types';

function sample() {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'Order Service' });
  const b = createNode({ type: 'queue', x: 300, y: 0, text: 'Topic' });
  const edge = createEdge({ source: a.id, target: b.id, label: 'ORDER_CREATED' });
  return { a, b, edge, doc: addEdges(addNodes(createDocument('Flow'), [a, b]), [edge]) };
}

describe('document model', () => {
  it('creates a versioned, empty document', () => {
    const doc = createDocument('Payment Flow');
    expect(doc.format).toBe(DRAFT_FORMAT);
    expect(doc.version).toBe(CURRENT_VERSION);
    expect(doc.metadata.title).toBe('Payment Flow');
    expect(doc.nodes).toHaveLength(0);
  });

  it('rejects edges whose endpoints do not exist', () => {
    const doc = createDocument();
    const next = addEdges(doc, [createEdge({ source: 'nope', target: 'also-nope' })]);
    expect(next.edges).toHaveLength(0);
    expect(next).toBe(doc);
  });

  it('preserves object identity for untouched nodes', () => {
    const { doc, a } = sample();
    const next = updateNode(doc, a.id, { text: 'Renamed' });
    expect(next.nodes[0]).not.toBe(doc.nodes[0]);
    // Structural sharing is what makes snapshot history cheap.
    expect(next.nodes[1]).toBe(doc.nodes[1]);
    expect(next.edges).toBe(doc.edges);
  });

  it('returns the same document when an operation changes nothing', () => {
    const { doc } = sample();
    expect(moveNodes(doc, new Map())).toBe(doc);
    expect(addNodes(doc, [])).toBe(doc);
  });

  it('cascades edge removal when a node is deleted', () => {
    const { doc, a } = sample();
    const next = removeElements(doc, [a.id]);
    expect(next.nodes).toHaveLength(1);
    expect(next.edges).toHaveLength(0);
  });

  it('deletes the contents of a boundary along with it', () => {
    const boundary = createNode({ type: 'group', x: 0, y: 0 });
    const child = createNode({ type: 'card', x: 20, y: 20, parentId: boundary.id });
    const doc = addNodes(createDocument(), [boundary, child]);
    expect(removeElements(doc, [boundary.id]).nodes).toHaveLength(0);
  });

  it('clamps coordinates and sizes to sane ranges', () => {
    const { doc, a } = sample();
    const next = updateNode(doc, a.id, { x: 1e12, width: 2 });
    expect(next.nodes[0]!.x).toBeLessThanOrEqual(1_000_000);
    expect(next.nodes[0]!.width).toBeGreaterThanOrEqual(24);
  });

  it('falls back to a placeholder for a blank title', () => {
    expect(setTitle(createDocument(), '   ').metadata.title).toBe('Untitled canvas');
  });

  it('copies a fragment with fresh ids and no dangling references', () => {
    const { doc, a, b } = sample();
    const fragment = extractFragment(doc, [a.id, b.id]);
    expect(fragment.nodes).toHaveLength(2);
    expect(fragment.edges).toHaveLength(1);

    const result = pasteFragment(doc, fragment, { x: 40, y: 40 });
    expect(result.doc.nodes).toHaveLength(4);
    expect(result.nodeIds).not.toContain(a.id);

    const pasted = result.doc.nodes.filter((node) => result.nodeIds.includes(node.id));
    expect(pasted[0]!.x).toBe(40);
    const pastedEdge = result.doc.edges.find((edge) => result.edgeIds.includes(edge.id))!;
    expect(result.nodeIds).toContain(pastedEdge.source);
    expect(result.nodeIds).toContain(pastedEdge.target);
  });

  it('excludes edges that leave the copied fragment', () => {
    const { doc, a } = sample();
    expect(extractFragment(doc, [a.id]).edges).toHaveLength(0);
  });

  it('aligns and distributes selections', () => {
    const nodes = [
      createNode({ type: 'card', x: 0, y: 0, width: 100, height: 50 }),
      createNode({ type: 'card', x: 130, y: 40, width: 100, height: 50 }),
      createNode({ type: 'card', x: 400, y: 90, width: 100, height: 50 }),
    ];
    const doc = addNodes(createDocument(), nodes);
    const ids = nodes.map((node) => node.id);

    const aligned = alignNodes(doc, ids, 'top');
    expect(aligned.nodes.every((node) => node.y === 0)).toBe(true);

    const spread = distributeNodes(aligned, ids, 'x');
    const gaps = [
      spread.nodes[1]!.x - (spread.nodes[0]!.x + 100),
      spread.nodes[2]!.x - (spread.nodes[1]!.x + 100),
    ];
    expect(gaps[0]).toBeCloseTo(gaps[1]!, 5);
  });

  it('computes content bounds', () => {
    const { doc } = sample();
    const bounds = boundsOf(doc.nodes)!;
    expect(bounds.x).toBe(0);
    expect(bounds.width).toBeGreaterThan(300);
    expect(boundsOf([])).toBeNull();
  });
});
