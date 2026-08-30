import { beforeEach, describe, expect, it } from 'vitest';
import { createAttachment, createDocument, createNode } from '../src/document/factory';
import {
  addNodes,
  attachToNode,
  detachFromNode,
  removeAttachment,
  reorderAttachment,
  updateAttachment,
} from '../src/document/operations';
import { normalizeDocument } from '../src/document/validate';
import { DRAFT_FORMAT, CURRENT_VERSION } from '../src/document/types';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

function docWithHost() {
  const host = createNode({ type: 'service', x: 100, y: 100, text: 'Loan Account Service' });
  return { host, doc: addNodes(createDocument('Attachments'), [host]) };
}

describe('attachment operations', () => {
  it('attaches, then lists the attachment on the host', () => {
    const { host, doc } = docWithHost();
    const attachment = createAttachment({ type: 'code', language: 'json', code: '{}' });
    const next = attachToNode(doc, host.id, attachment);
    expect(next.nodes[0]!.attachments).toHaveLength(1);
    expect(next.nodes[0]!.attachments![0]!.id).toBe(attachment.id);
  });

  it('detaches into a real, freestanding node placed beside the host, not at an old position', () => {
    const { host, doc } = docWithHost();
    const attachment = createAttachment({
      type: 'code',
      language: 'json',
      code: '{}',
      width: 300,
      height: 150,
    });
    const attached = attachToNode(doc, host.id, attachment);

    const { doc: detached, extractedNode } = detachFromNode(attached, host.id, attachment.id);
    expect(extractedNode).not.toBeNull();
    expect(extractedNode!.width).toBe(300);
    expect(extractedNode!.height).toBe(150);
    expect(extractedNode!.x).toBe(host.x + host.width + 32);
    expect(extractedNode!.y).toBe(host.y);
    expect(detached.nodes.find((n) => n.id === host.id)!.attachments ?? []).toHaveLength(0);
    expect(detached.nodes.some((n) => n.id === extractedNode!.id)).toBe(true);
  });

  it('falls back to placing the detached node below the host when beside it is out of range', () => {
    // LIMITS.maxCoordinate is 1_000_000 — place the host close enough to it
    // that `host.x + host.width + 32` would spill over.
    const host = createNode({
      type: 'service',
      x: 999_900,
      y: 500,
      width: 176,
      height: 68,
      text: 'Edge-of-map Service',
    });
    const doc = addNodes(createDocument(), [host]);
    const attachment = createAttachment({ type: 'note', text: 'note' });
    const attached = attachToNode(doc, host.id, attachment);

    const { extractedNode } = detachFromNode(attached, host.id, attachment.id);
    expect(extractedNode!.x).toBe(host.x);
    expect(extractedNode!.y).toBe(host.y + host.height + 32);
  });

  it('updates an attachment in place without changing its id', () => {
    const { host, doc } = docWithHost();
    const attachment = createAttachment({ type: 'note', text: 'draft' });
    const attached = attachToNode(doc, host.id, attachment);

    const updated = updateAttachment(attached, host.id, attachment.id, { text: 'final' });
    const stored = updated.nodes[0]!.attachments![0]!;
    expect(stored.id).toBe(attachment.id);
    expect(stored.text).toBe('final');
  });

  it('keeps the attachment id stable across an update, then a reorder', () => {
    const { host, doc } = docWithHost();
    const a = createAttachment({ type: 'note', text: 'A' });
    const b = createAttachment({ type: 'note', text: 'B' });
    let next = attachToNode(doc, host.id, a);
    next = attachToNode(next, host.id, b);

    next = updateAttachment(next, host.id, a.id, { text: 'A updated' });
    next = reorderAttachment(next, host.id, a.id, 1);

    const ids = next.nodes[0]!.attachments!.map((att) => att.id);
    expect(ids).toEqual([b.id, a.id]);
    expect(next.nodes[0]!.attachments!.find((att) => att.id === a.id)!.text).toBe('A updated');
  });

  it('removes an attachment', () => {
    const { host, doc } = docWithHost();
    const attachment = createAttachment({ type: 'note', text: 'gone soon' });
    const attached = attachToNode(doc, host.id, attachment);
    const removed = removeAttachment(attached, host.id, attachment.id);
    expect(removed.nodes[0]!.attachments ?? []).toHaveLength(0);
  });

  it('reorders attachments and clamps at the ends', () => {
    const { host, doc } = docWithHost();
    const a = createAttachment({ type: 'note', text: 'A' });
    const b = createAttachment({ type: 'note', text: 'B' });
    let next = attachToNode(doc, host.id, a);
    next = attachToNode(next, host.id, b);

    // Already first: moving up is a no-op, not an error.
    const unchanged = reorderAttachment(next, host.id, a.id, -1);
    expect(unchanged).toBe(next);

    const moved = reorderAttachment(next, host.id, a.id, 1);
    expect(moved.nodes[0]!.attachments!.map((att) => att.id)).toEqual([b.id, a.id]);
  });
});

describe('attachment import validation', () => {
  it('repairs malformed attachments without dropping the host node', () => {
    const raw = {
      format: DRAFT_FORMAT,
      version: CURRENT_VERSION,
      nodes: [
        {
          id: 'n_host',
          type: 'service',
          x: 0,
          y: 0,
          width: 176,
          height: 68,
          attachments: [
            { id: 'a_1', type: 'note', text: 'kept' },
            { type: 'bogus-type', text: 'coerced to note' },
            'not-an-object',
            { id: 'a_1', type: 'note', text: 'duplicate id gets a new one' },
          ],
        },
      ],
      edges: [],
    };

    const result = normalizeDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const host = result.document.nodes.find((n) => n.id === 'n_host')!;
    expect(host).toBeDefined();
    expect(host.attachments).toHaveLength(3);
    expect(host.attachments!.every((a) => typeof a.id === 'string' && a.id.length > 0)).toBe(true);
    const ids = new Set(host.attachments!.map((a) => a.id));
    expect(ids.size).toBe(3);
    expect(result.repairs.length).toBeGreaterThan(0);
  });

  it('caps attachments per node at the configured limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `a_${i}`, type: 'note', text: `#${i}` }));
    const raw = {
      format: DRAFT_FORMAT,
      version: CURRENT_VERSION,
      nodes: [{ id: 'n_host', type: 'service', x: 0, y: 0, attachments: many }],
      edges: [],
    };

    const result = normalizeDocument(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const host = result.document.nodes[0]!;
    expect(host.attachments!.length).toBeLessThanOrEqual(12);
    expect(result.repairs.some((r) => r.includes('too many attachments'))).toBe(true);
  });
});

describe('attachments through the store', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Attachments'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('undoes and redoes an attach', () => {
    const host = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const attachment = createAttachment({ type: 'note', text: 'context' });
    store.getState().attachToNode(host.id, attachment);
    expect(store.getState().document.nodes[0]!.attachments).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().document.nodes[0]!.attachments ?? []).toHaveLength(0);
    store.getState().redo();
    expect(store.getState().document.nodes[0]!.attachments).toHaveLength(1);
  });

  it('detaching selects the newly-materialized node, and undo restores the attachment', () => {
    const host = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const attachment = createAttachment({ type: 'code', language: 'json', code: '{}' });
    store.getState().attachToNode(host.id, attachment);

    store.getState().detachAttachment(host.id, attachment.id);
    const doc = store.getState().document;
    expect(doc.nodes).toHaveLength(2);
    const detachedId = doc.nodes.find((n) => n.id !== host.id)!.id;
    expect(store.getState().selection.nodes).toEqual([detachedId]);

    store.getState().undo();
    expect(store.getState().document.nodes).toHaveLength(1);
    expect(store.getState().document.nodes[0]!.attachments).toHaveLength(1);
  });

  it('removing an attachment is one undo step', () => {
    const host = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const attachment = createAttachment({ type: 'note', text: 'temp' });
    store.getState().attachToNode(host.id, attachment);
    const before = store.getState().history.past.length;

    store.getState().removeAttachment(host.id, attachment.id);
    expect(store.getState().document.nodes[0]!.attachments ?? []).toHaveLength(0);
    expect(store.getState().history.past).toHaveLength(before + 1);

    store.getState().undo();
    expect(store.getState().document.nodes[0]!.attachments).toHaveLength(1);
  });
});
