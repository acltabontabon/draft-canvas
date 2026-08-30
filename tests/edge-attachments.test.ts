import { beforeEach, describe, expect, it } from 'vitest';
import { createAttachment, createDocument, createEdge, createNode } from '../src/document/factory';
import {
  addEdges,
  addNodes,
  attachToEdge,
  reconnectEdge,
  removeEdgeAttachment,
  removeElements,
  updateEdgeAttachment,
} from '../src/document/operations';
import { normalizeDocument } from '../src/document/validate';
import { DRAFT_FORMAT, CURRENT_VERSION } from '../src/document/types';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

function docWithEdge() {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'Loan Application Service' });
  const b = createNode({ type: 'queue', x: 400, y: 0, text: 'Loan Events' });
  const edge = createEdge({ source: a.id, target: b.id, semantic: 'publishes' });
  const doc = addEdges(addNodes(createDocument('Edge attachments'), [a, b]), [edge]);
  return { a, b, edge, doc };
}

describe('edge attachment operations', () => {
  it('attaches, then lists the attachment on the edge', () => {
    const { edge, doc } = docWithEdge();
    const attachment = createAttachment({ type: 'code', language: 'json', code: '{"event":"LOAN_APPROVED"}' });
    const next = attachToEdge(doc, edge.id, attachment);
    expect(next.edges[0]!.attachments).toHaveLength(1);
    expect(next.edges[0]!.attachments![0]!.id).toBe(attachment.id);
  });

  it('caps attachments per edge and keeps the earliest ones', () => {
    const { edge, doc } = docWithEdge();
    let next = doc;
    const attachments = Array.from({ length: 6 }, (_, i) => createAttachment({ type: 'note', text: `#${i}` }));
    for (const attachment of attachments) next = attachToEdge(next, edge.id, attachment);
    expect(next.edges[0]!.attachments!.length).toBeLessThanOrEqual(4);
    expect(next.edges[0]!.attachments![0]!.text).toBe('#0');
  });

  it('updates an edge attachment in place without changing its id', () => {
    const { edge, doc } = docWithEdge();
    const attachment = createAttachment({ type: 'note', text: 'draft' });
    const attached = attachToEdge(doc, edge.id, attachment);

    const updated = updateEdgeAttachment(attached, edge.id, attachment.id, { text: 'final' });
    const stored = updated.edges[0]!.attachments![0]!;
    expect(stored.id).toBe(attachment.id);
    expect(stored.text).toBe('final');
  });

  it('removes an edge attachment, leaving no attachments field once empty', () => {
    const { edge, doc } = docWithEdge();
    const attachment = createAttachment({ type: 'note', text: 'gone soon' });
    const attached = attachToEdge(doc, edge.id, attachment);
    const removed = removeEdgeAttachment(attached, edge.id, attachment.id);
    expect(removed.edges[0]!.attachments ?? []).toHaveLength(0);
  });

  it('a no-op remove (unknown attachment id) returns the same document', () => {
    const { edge, doc } = docWithEdge();
    const attachment = createAttachment({ type: 'note', text: 'kept' });
    const attached = attachToEdge(doc, edge.id, attachment);
    const unchanged = removeEdgeAttachment(attached, edge.id, 'not-a-real-id');
    expect(unchanged).toBe(attached);
  });

  it('deleting the edge discards its attachment for free — no separate cascade code needed', () => {
    const { edge, doc } = docWithEdge();
    const attachment = createAttachment({ type: 'code', language: 'json', code: '{}' });
    const attached = attachToEdge(doc, edge.id, attachment);
    const afterDelete = removeElements(attached, [], [edge.id]);
    expect(afterDelete.edges).toHaveLength(0);
  });

  it('reconnecting an edge preserves its attachment untouched', () => {
    const { a, edge, doc } = docWithEdge();
    const third = createNode({ type: 'queue', x: 400, y: 400, text: 'Other Topic' });
    const withThird = addNodes(doc, [third]);
    const attachment = createAttachment({ type: 'code', language: 'json', code: '{"event":"X"}' });
    const attached = attachToEdge(withThird, edge.id, attachment);

    const reconnected = reconnectEdge(attached, edge.id, 'target', third.id, 'left', 0.5);
    const reconnectedEdge = reconnected.edges.find((e) => e.id === edge.id)!;
    expect(reconnectedEdge.target).toBe(third.id);
    expect(reconnectedEdge.source).toBe(a.id);
    expect(reconnectedEdge.attachments).toHaveLength(1);
    expect(reconnectedEdge.attachments![0]!.id).toBe(attachment.id);
  });
});

describe('edge attachment import validation', () => {
  function baseDoc(edgeAttachments: unknown) {
    return {
      format: DRAFT_FORMAT,
      version: CURRENT_VERSION,
      nodes: [
        { id: 'n_a', type: 'service', x: 0, y: 0, width: 176, height: 68 },
        { id: 'n_b', type: 'queue', x: 400, y: 0, width: 176, height: 68 },
      ],
      edges: [
        {
          id: 'e_1',
          source: 'n_a',
          target: 'n_b',
          directed: true,
          routing: 'smoothstep',
          attachments: edgeAttachments,
        },
      ],
    };
  }

  it('repairs malformed edge attachments without dropping the connection', () => {
    const raw = baseDoc([
      { id: 'ea_1', type: 'code', language: 'json', code: '{}' },
      { type: 'bogus-type', text: 'coerced to note' },
      'not-an-object',
      { id: 'ea_1', type: 'note', text: 'duplicate id gets a new one' },
    ]);

    const result = normalizeDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const edge = result.document.edges.find((e) => e.id === 'e_1')!;
    expect(edge).toBeDefined();
    expect(edge.attachments).toHaveLength(3);
    expect(edge.attachments!.every((a) => typeof a.id === 'string' && a.id.length > 0)).toBe(true);
    const ids = new Set(edge.attachments!.map((a) => a.id));
    expect(ids.size).toBe(3);
    expect(result.repairs.length).toBeGreaterThan(0);
  });

  it('caps edge attachments at the configured limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `ea_${i}`, type: 'note', text: `#${i}` }));
    const raw = baseDoc(many);

    const result = normalizeDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edge = result.document.edges[0]!;
    expect(edge.attachments!.length).toBeLessThanOrEqual(4);
    expect(result.repairs.some((r) => r.includes('too many attachments'))).toBe(true);
  });

  it('a legacy diagram with no attachments field on its edges loads unchanged', () => {
    const raw = baseDoc(undefined);
    const result = normalizeDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edge = result.document.edges[0]!;
    expect(edge.attachments).toBeUndefined();
  });
});

describe('edge attachments through the store', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Edge attachments'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  function connectedEdge() {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'queue', x: 400, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    return edge;
  }

  it('undoes and redoes an attach', () => {
    const edge = connectedEdge();
    const attachment = createAttachment({ type: 'note', text: 'context' });
    store.getState().attachToEdge(edge.id, attachment);
    expect(store.getState().document.edges.find((e) => e.id === edge.id)!.attachments).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().document.edges.find((e) => e.id === edge.id)!.attachments ?? []).toHaveLength(0);
    store.getState().redo();
    expect(store.getState().document.edges.find((e) => e.id === edge.id)!.attachments).toHaveLength(1);
  });

  it('removing an edge attachment is one undo step', () => {
    const edge = connectedEdge();
    const attachment = createAttachment({ type: 'note', text: 'temp' });
    store.getState().attachToEdge(edge.id, attachment);
    const before = store.getState().history.past.length;

    store.getState().removeEdgeAttachment(edge.id, attachment.id);
    expect(store.getState().document.edges.find((e) => e.id === edge.id)!.attachments ?? []).toHaveLength(0);
    expect(store.getState().history.past).toHaveLength(before + 1);

    store.getState().undo();
    expect(store.getState().document.edges.find((e) => e.id === edge.id)!.attachments).toHaveLength(1);
  });

  it('deleting the edge and undoing restores both the connection and its attachment together', () => {
    const edge = connectedEdge();
    const attachment = createAttachment({ type: 'code', language: 'json', code: '{}' });
    store.getState().attachToEdge(edge.id, attachment);

    store.setState({ selection: { nodes: [], edges: [edge.id] } });
    store.getState().deleteSelection();
    expect(store.getState().document.edges).toHaveLength(0);

    store.getState().undo();
    const restored = store.getState().document.edges.find((e) => e.id === edge.id);
    expect(restored).toBeDefined();
    expect(restored!.attachments).toHaveLength(1);
    expect(restored!.attachments![0]!.id).toBe(attachment.id);
  });
});
