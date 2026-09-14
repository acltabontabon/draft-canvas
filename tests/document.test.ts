import { beforeEach, describe, expect, it } from 'vitest';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { createAttachment, createDocument, createEdge, createNode, displayNameFor } from '../src/document/factory';
import {
  addEdges,
  addNodes,
  alignNodes,
  boundsOf,
  bringForward,
  bringToFront,
  descendantsOf,
  reconnectEdge,
  reverseEdge,
  tryPlaceNear,
  updateAttachment,
  distributeNodes,
  extractFragment,
  moveNodes,
  pasteFragment,
  removeElements,
  sendBackward,
  sendToBack,
  setParent,
  setTitle,
  updateNode,
} from '../src/document/operations';
import { CURRENT_VERSION, DRAFT_FORMAT, SERVICE_KINDS } from '../src/document/types';
import { LIMITS } from '../src/document/limits';

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

  it('never lets a non-finite coordinate or size patch through as NaN/Infinity', () => {
    const { doc, a } = sample();
    const next = updateNode(doc, a.id, { x: NaN, y: Infinity, width: NaN, height: -Infinity });
    for (const value of [next.nodes[0]!.x, next.nodes[0]!.y, next.nodes[0]!.width, next.nodes[0]!.height]) {
      expect(Number.isFinite(value)).toBe(true);
    }
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

  it('un-parents pasted children whose boundary was cut by the node cap', () => {
    const filler = Array.from({ length: LIMITS.maxNodes - 2 }, (_, i) => createNode({ type: 'note', x: i, y: 0 }));
    const group = createNode({ type: 'group', x: 0, y: 0, width: 400, height: 300 });
    const child = { ...createNode({ type: 'service', x: 20, y: 20 }), parentId: group.id };
    // Members before their boundary, the order `groupSelection` leaves them in.
    const fragment = { nodes: [child, createNode({ type: 'service', x: 60, y: 60 }), group], edges: [] };
    const result = pasteFragment(addNodes(createDocument(), filler), fragment, { x: 0, y: 0 });

    expect(result.truncated).toBe(true);
    expect(result.nodeIds).toHaveLength(2);
    const ids = new Set(result.doc.nodes.map((n) => n.id));
    for (const node of result.doc.nodes) if (node.parentId) expect(ids.has(node.parentId)).toBe(true);
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

  it('exposes exactly six Service kinds — Backend for Frontend is a labeled API Service, not its own kind', () => {
    expect(SERVICE_KINDS).toEqual(['generic', 'api', 'worker', 'external', 'scheduler', 'gateway']);
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

  it('setParent is a true no-op — same document reference — for an empty or non-matching id set', () => {
    const boundary = createNode({ type: 'group', x: 0, y: 0, width: 400, height: 400 });
    const doc = addNodes(createDocument(), [boundary]);
    expect(setParent(doc, [], boundary.id)).toBe(doc);
    expect(setParent(doc, ['does-not-exist'], boundary.id)).toBe(doc);
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

describe('group / ungroup keep nesting intact', () => {
  const store = useEditorStore;
  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Nesting'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      revision: 0,
    });
  });

  function outerWith(count: number) {
    const outer = store.getState().addNode({ type: 'group', x: 0, y: 0, width: 1200, height: 800 });
    const kids = Array.from({ length: count }, (_, i) => store.getState().addNode({ type: 'service', x: 100 + i * 300, y: 100 }));
    store.getState().apply('Seed', (doc) => setParent(doc, kids.map((k) => k.id), outer.id));
    return { outer, kids };
  }
  const nodeById = (id: string) => store.getState().document.nodes.find((n) => n.id === id)!;

  it('grouping nodes inside a boundary nests the new boundary there', () => {
    const { outer, kids } = outerWith(2);
    store.getState().setSelection({ nodes: kids.map((k) => k.id), edges: [] });
    store.getState().groupSelection();
    const inner = store.getState().selection.nodes[0]!;
    expect(nodeById(inner).parentId).toBe(outer.id);
    expect(nodeById(inner).z).toBeGreaterThan(nodeById(outer.id).z);
    expect(kids.every((k) => nodeById(k.id).parentId === inner)).toBe(true);
    expect(new Set(descendantsOf(store.getState().document, outer.id))).toEqual(new Set([inner, ...kids.map((k) => k.id)]));
  });

  it('grouping a boundary together with its own children leaves those children where they are', () => {
    const { outer, kids } = outerWith(2);
    const loose = store.getState().addNode({ type: 'service', x: 1400, y: 100 });
    store.getState().setSelection({ nodes: [outer.id, ...kids.map((k) => k.id), loose.id], edges: [] });
    store.getState().groupSelection();
    expect(kids.every((k) => nodeById(k.id).parentId === outer.id)).toBe(true);
    expect(nodeById(outer.id).parentId).toBe(store.getState().selection.nodes[0]);
  });

  it('ungrouping an inner boundary hands its children to the outer one', () => {
    const { outer, kids } = outerWith(2);
    store.getState().setSelection({ nodes: kids.map((k) => k.id), edges: [] });
    store.getState().groupSelection();
    store.getState().ungroupSelection();
    expect(kids.every((k) => nodeById(k.id).parentId === outer.id)).toBe(true);
  });

  it('ungrouping drops connectors drawn to the boundary itself, and the flow steps that walked them', () => {
    const { outer, kids } = outerWith(1);
    const db = store.getState().addNode({ type: 'service', x: 1400, y: 100 });
    const toBoundary = store.getState().connect(outer.id, db.id)!;
    const inner = store.getState().connect(kids[0]!.id, db.id)!;
    const flowId = store.getState().createFlow('Story')!;
    store.getState().addEdgeToFlow(flowId, toBoundary.id);
    store.getState().addEdgeToFlow(flowId, inner.id);

    store.getState().setSelection({ nodes: [outer.id], edges: [] });
    store.getState().ungroupSelection();

    const doc = store.getState().document;
    expect(doc.edges.map((e) => e.id)).toEqual([inner.id]);
    expect(doc.flows[0]!.steps.map((s) => s.edgeId)).toEqual([inner.id]);
  });

  it('cut and paste of a boundary brings back its contents and their connectors', () => {
    const { outer, kids } = outerWith(2);
    store.getState().connect(kids[0]!.id, kids[1]!.id);
    store.getState().setSelection({ nodes: [outer.id], edges: [] });
    store.getState().cutSelection();
    expect(store.getState().document.nodes).toHaveLength(0);

    store.getState().paste();
    const doc = store.getState().document;
    const boundary = doc.nodes.find((n) => n.type === 'group')!;
    expect(doc.nodes.filter((n) => n.parentId === boundary.id)).toHaveLength(2);
    expect(doc.edges).toHaveLength(1);
  });

  it('nudging, aligning and distributing a boundary carries its contents along', () => {
    const { outer, kids } = outerWith(1);
    const kid = kids[0]!;
    store.getState().setSelection({ nodes: [outer.id], edges: [] });
    store.getState().nudgeSelection(10, 0);
    expect(nodeById(kid.id).x).toBe(kid.x + 10);

    const loose = store.getState().addNode({ type: 'service', x: 0, y: 1000 });
    const kidBefore = nodeById(kid.id);
    store.getState().setSelection({ nodes: [outer.id, loose.id], edges: [] });
    store.getState().align('bottom');
    const dy = nodeById(outer.id).y;
    expect(dy).toBeGreaterThan(0);
    expect(nodeById(kid.id).y).toBe(kidBefore.y + dy);
  });
});

describe('insert worker', () => {
  it('keeps the replaced connector\'s label, condition and attachments on the inbound leg', () => {
    const store = useEditorStore;
    __resetInteraction();
    store.setState({ document: createDocument('Worker'), history: { past: [], future: [] }, selection: { nodes: [], edges: [] }, revision: 0 });
    const queue = store.getState().addNode({ type: 'queue', x: 0, y: 0 });
    const target = store.getState().addNode({ type: 'service', x: 600, y: 0 });
    const edge = store.getState().connect(queue.id, target.id)!;
    const note = createAttachment({ type: 'note', text: 'payload' });
    store.getState().apply('Seed', (doc) => ({
      ...doc,
      edges: doc.edges.map((e) => (e.id === edge.id ? { ...e, label: 'ORDER_CREATED', condition: 'paid', attachments: [note] } : e)),
    }));

    store.getState().insertWorkerOnEdge(edge.id);

    const doc = store.getState().document;
    const inbound = doc.edges.find((e) => e.source === queue.id)!;
    const outbound = doc.edges.find((e) => e.target === target.id)!;
    expect(inbound.label).toBe('ORDER_CREATED');
    expect(inbound.condition).toBe('paid');
    expect(inbound.attachments).toEqual([note]);
    expect(outbound.label).toBeUndefined();
    expect(outbound.attachments).toBeUndefined();
  });
});

describe('z-order', () => {
  it('bringForward/sendBackward/bringToFront/sendToBack are true no-ops — same document reference — for an empty or non-matching id set', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, z: 0 });
    const b = createNode({ type: 'service', x: 200, y: 0, z: 1 });
    const doc = addNodes(createDocument(), [a, b]);

    for (const op of [bringForward, sendBackward, bringToFront, sendToBack]) {
      expect(op(doc, [])).toBe(doc);
      expect(op(doc, ['does-not-exist'])).toBe(doc);
    }
  });

  it('bringing the front node forward, or sending the back node backward, changes nothing', () => {
    const a = createNode({ type: 'service', x: 0, y: 0, z: 0 });
    const b = createNode({ type: 'service', x: 200, y: 0, z: 1 });
    const doc = addNodes(createDocument(), [a, b]);

    expect(bringToFront(doc, [b.id])).toBe(doc);
    expect(bringForward(doc, [b.id])).toBe(doc);
    expect(sendToBack(doc, [a.id])).toBe(doc);
    expect(sendBackward(doc, [a.id])).toBe(doc);
    expect(bringToFront(doc, [a.id]).nodes[0]!.z).toBe(2);
  });
});

describe('no-op edits and duplicate connectors', () => {
  it('dropping a connector end back on the handle it came from changes nothing', () => {
    const { doc, b, edge } = sample();
    expect(reconnectEdge(doc, edge.id, 'target', b.id, undefined)).toBe(doc);
    const anchored = reconnectEdge(doc, edge.id, 'target', b.id, 'left', 0.25);
    expect(anchored).not.toBe(doc);
    expect(reconnectEdge(anchored, edge.id, 'target', b.id, 'left', 0.25)).toBe(anchored);
  });

  it('reversing a connector refuses to stack it on an existing opposite one', () => {
    const { doc, a, b, edge } = sample();
    const both = addEdges(doc, [createEdge({ source: b.id, target: a.id })]);
    expect(reverseEdge(both, edge.id)).toBe(both);
    expect(reverseEdge(doc, edge.id)).not.toBe(doc);
  });

  it('an attachment edit that changes nothing returns the same document', () => {
    const { doc, a } = sample();
    const attachment = createAttachment({ type: 'note', text: 'Hi' });
    const withNote = updateNode(doc, a.id, { attachments: [attachment] });
    expect(updateAttachment(withNote, a.id, attachment.id, { text: 'Hi' })).toBe(withNote);
    expect(updateAttachment(withNote, a.id, attachment.id, { text: 'Bye' })).not.toBe(withNote);
  });

  it("placing next to a node never lands inside a boundary it isn't in, but can stay inside its own", () => {
    const host = createNode({ type: 'service', x: 0, y: 0 });
    const foreign = createNode({ type: 'group', x: host.width + 20, y: -100, width: 600, height: 400 });
    const doc = addNodes(createDocument(), [host, foreign]);
    const spot = tryPlaceNear(doc, host, { width: 176, height: 68 })!;
    const placed = { ...spot, width: 176, height: 68 };
    const overlaps =
      placed.x < foreign.x + foreign.width && placed.x + placed.width > foreign.x &&
      placed.y < foreign.y + foreign.height && placed.y + placed.height > foreign.y;
    expect(overlaps).toBe(false);

    const own = createNode({ type: 'group', x: -200, y: -200, width: 1200, height: 800 });
    const inside = addNodes(createDocument(), [own, { ...host, parentId: own.id }]);
    const nearby = tryPlaceNear(inside, host, { width: 176, height: 68 }, undefined, { parent: inside.nodes[0] })!;
    expect(nearby.x).toBeGreaterThan(host.x + host.width);
  });

  it('only a boundary can become a parent', () => {
    const { doc, a, b } = sample();
    expect(setParent(doc, [a.id], b.id)).toBe(doc);
    const group = createNode({ type: 'group', x: -50, y: -50, width: 800, height: 400 });
    const grouped = setParent(addNodes(doc, [group]), [a.id], group.id);
    expect(grouped.nodes.find((n) => n.id === a.id)!.parentId).toBe(group.id);
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
