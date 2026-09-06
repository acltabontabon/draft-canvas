import { describe, expect, it } from 'vitest';
import { createAttachment, createDocument, createEdge, createNode, displayNameFor } from '../src/document/factory';
import {
  addEdges,
  addNodes,
  alignNodes,
  boundsOf,
  descendantsOf,
  distributeNodes,
  extractFragment,
  moveNodes,
  pasteFragment,
  removeElements,
  setParent,
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

  it('a freshly created queue node has no name of its own — its kind is the only label', () => {
    const node = createNode({ type: 'queue', x: 0, y: 0 });
    expect(node.queueKind).toBe('queue');
    expect(node.text).toBe('');
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
    const child = createNode({ type: 'note', x: 20, y: 20, parentId: boundary.id });
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

  it('gives a pasted node fresh attachment ids, not the original ones', () => {
    const attachment = createAttachment({ type: 'note', text: 'Watch out' });
    const node = { ...createNode({ type: 'service', x: 0, y: 0 }), attachments: [attachment] };
    const doc = addNodes(createDocument(), [node]);

    const fragment = extractFragment(doc, [node.id]);
    const result = pasteFragment(doc, fragment, { x: 40, y: 40 });

    const pasted = result.doc.nodes.find((n) => result.nodeIds.includes(n.id))!;
    expect(pasted.attachments).toHaveLength(1);
    expect(pasted.attachments![0]!.id).not.toBe(attachment.id);
    expect(pasted.attachments![0]!.text).toBe('Watch out');
    // The original is untouched.
    expect(result.doc.nodes.find((n) => n.id === node.id)!.attachments![0]!.id).toBe(attachment.id);
  });

  it('aligns and distributes selections', () => {
    const nodes = [
      createNode({ type: 'note', x: 0, y: 0, width: 100, height: 50 }),
      createNode({ type: 'note', x: 130, y: 40, width: 100, height: 50 }),
      createNode({ type: 'note', x: 400, y: 90, width: 100, height: 50 }),
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

describe('createNode — a Service\'s default label follows its subtype', () => {
  it('names a fresh node for its serviceKind, not the generic "Service" literal', () => {
    expect(createNode({ type: 'service', x: 0, y: 0 }).text).toBe('Service');
    expect(createNode({ type: 'service', x: 0, y: 0, serviceKind: 'generic' }).text).toBe('Service');
    expect(createNode({ type: 'service', x: 0, y: 0, serviceKind: 'api' }).text).toBe('API');
    expect(createNode({ type: 'service', x: 0, y: 0, serviceKind: 'worker' }).text).toBe('Worker');
    expect(createNode({ type: 'service', x: 0, y: 0, serviceKind: 'scheduler' }).text).toBe('Scheduler');
    expect(createNode({ type: 'service', x: 0, y: 0, serviceKind: 'gateway' }).text).toBe('Gateway');
    expect(createNode({ type: 'service', x: 0, y: 0, serviceKind: 'external' }).text).toBe('External System');
  });

  it('marks an auto-generated label as textOrigin "auto", so it stays eligible to follow later subtype changes', () => {
    const node = createNode({ type: 'service', x: 0, y: 0, serviceKind: 'api' });
    expect(node.textOrigin).toBe('auto');
  });

  it('marks a caller-supplied label as textOrigin "explicit", regardless of subtype', () => {
    const node = createNode({ type: 'service', x: 0, y: 0, serviceKind: 'api', text: 'Payments' });
    expect(node.text).toBe('Payments');
    expect(node.textOrigin).toBe('explicit');
  });
});

describe('containment', () => {
  it('finds every transitive descendant of a boundary', () => {
    const outer = createNode({ type: 'group', x: 0, y: 0, width: 600, height: 600 });
    const inner = createNode({ type: 'group', x: 50, y: 50, width: 300, height: 300 });
    const leaf = createNode({ type: 'note', x: 100, y: 100 });
    let doc = addNodes(createDocument(), [outer, inner, leaf]);
    doc = setParent(doc, [inner.id], outer.id);
    doc = setParent(doc, [leaf.id], inner.id);

    expect(new Set(descendantsOf(doc, outer.id))).toEqual(new Set([inner.id, leaf.id]));
    expect(descendantsOf(doc, inner.id)).toEqual([leaf.id]);
    expect(descendantsOf(doc, leaf.id)).toEqual([]);
  });

  it('refuses to reparent a node under its own descendant', () => {
    // `Canvas.tsx`'s drag-drop already excludes this via `descendantsOf`
    // before ever offering a drop target — this is `setParent` itself
    // refusing the same cycle, so correctness doesn't depend on every future
    // caller remembering to pre-filter.
    const outer = createNode({ type: 'group', x: 0, y: 0, width: 600, height: 600 });
    const inner = createNode({ type: 'group', x: 50, y: 50, width: 300, height: 300 });
    let doc = addNodes(createDocument(), [outer, inner]);
    doc = setParent(doc, [inner.id], outer.id);

    doc = setParent(doc, [outer.id], inner.id);

    const storedOuter = doc.nodes.find((n) => n.id === outer.id)!;
    expect(storedOuter.parentId).toBeUndefined();
    // The one already-valid relationship is untouched by the refused attempt.
    const storedInner = doc.nodes.find((n) => n.id === inner.id)!;
    expect(storedInner.parentId).toBe(outer.id);
  });

  it('leaves node coordinates untouched by parenting or unparenting', () => {
    const boundary = createNode({ type: 'group', x: 0, y: 0, width: 400, height: 400 });
    const child = createNode({ type: 'note', x: 120, y: 90 });
    let doc = addNodes(createDocument(), [boundary, child]);

    doc = setParent(doc, [child.id], boundary.id);
    let stored = doc.nodes.find((n) => n.id === child.id)!;
    expect(stored.x).toBe(120);
    expect(stored.y).toBe(90);
    expect(stored.parentId).toBe(boundary.id);

    doc = setParent(doc, [child.id], undefined);
    stored = doc.nodes.find((n) => n.id === child.id)!;
    expect(stored.x).toBe(120);
    expect(stored.y).toBe(90);
    expect(stored.parentId).toBeUndefined();
  });
});

describe('displayNameFor', () => {
  it('prefers the node\'s own text when set', () => {
    expect(displayNameFor({ type: 'service', text: 'Order Service' })).toBe('Order Service');
  });

  it('falls back to a Queue\'s kind, never "Untitled" — a Queue has no text field to type into', () => {
    expect(displayNameFor({ type: 'queue', text: '' })).toBe('Queue');
    expect(displayNameFor({ type: 'queue', text: '', queueKind: 'topic' })).toBe('Topic');
    expect(displayNameFor({ type: 'queue', text: '', queueKind: 'stream' })).toBe('Stream');
  });

  it('falls back to a sub-kind label for Service/Database when text is blank', () => {
    expect(displayNameFor({ type: 'service', text: '', serviceKind: 'external' })).toBe('External System');
    expect(displayNameFor({ type: 'database', text: '', databaseKind: 'cache' })).toBe('Cache');
    expect(displayNameFor({ type: 'service', text: '' })).toBe('Service');
    expect(displayNameFor({ type: 'database', text: '' })).toBe('Data Store');
  });

  it('falls back to a generic type name for every other blank-text type', () => {
    expect(displayNameFor({ type: 'note', text: '' })).toBe('Note');
    expect(displayNameFor({ type: 'code', text: '' })).toBe('Code');
    expect(displayNameFor({ type: 'text', text: '' })).toBe('Text');
    expect(displayNameFor({ type: 'ellipse', text: '' })).toBe('Junction');
    expect(displayNameFor({ type: 'actor', text: '' })).toBe('Actor');
    expect(displayNameFor({ type: 'group', text: '' })).toBe('Boundary');
  });

  it('treats whitespace-only text the same as blank', () => {
    expect(displayNameFor({ type: 'queue', text: '   ' })).toBe('Queue');
  });
});
