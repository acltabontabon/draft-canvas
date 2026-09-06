import { describe, expect, it } from 'vitest';
import { createAttachment, createDocument, createEdge, createNode } from '../src/document/factory';
import { addEdges, addNodes } from '../src/document/operations';
import { addFlow, createFlow } from '../src/document/flow';
import { deserializeDocument, serializeDocument, fileNameFor } from '../src/export/project';
import { CURRENT_VERSION } from '../src/document/types';

function richDocument() {
  const service = createNode({
    type: 'service',
    x: 40,
    y: 80,
    text: 'Order Service',
    accent: 'teal',
  });
  const queue = createNode({ type: 'queue', x: 380, y: 80, text: 'orders.v1', accent: 'violet' });
  const db = createNode({ type: 'database', x: 40, y: 260, text: 'orders' });
  const code = createNode({
    type: 'code',
    x: 380,
    y: 260,
    width: 420,
    height: 220,
    language: 'json',
    code: '{\n  "accountId": "123",\n  "status": "CANCELLED"\n}',
  });
  const note = createNode({
    type: 'note',
    x: 820,
    y: 80,
    text: 'Why is this retried twice?',
    noteKind: 'question',
  });
  note.attachments = [createAttachment({ type: 'note', text: 'Follow up with the payments team' })];

  const boundary = createNode({ type: 'group', x: 20, y: 40, width: 420, height: 300, text: 'Order domain' });
  db.parentId = boundary.id;

  const published = createEdge({
    source: service.id,
    target: queue.id,
    label: 'ORDER_CREATED',
  });
  const persisted = createEdge({ source: service.id, target: db.id });
  persisted.details = { language: 'sql', code: 'select * from orders where id = ?' };

  let doc = addNodes(createDocument('Payment Flow'), [service, queue, db, code, note, boundary]);
  doc = addEdges(doc, [published, persisted]);
  const flow = createFlow({ title: 'Happy path' });
  flow.steps = [
    { id: 'fs1', edgeId: published.id, caption: 'Publish the event' },
    { id: 'fs2', edgeId: persisted.id },
  ];
  doc = addFlow(doc, flow);
  return { ...doc, viewport: { x: -120, y: 40, zoom: 1.25 } };
}

describe('.draftcanvas round trip', () => {
  it('restores an identical, fully editable document', () => {
    const original = richDocument();
    const result = deserializeDocument(serializeDocument(original));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.repairs).toEqual([]);
    expect(result.document.metadata.title).toBe('Payment Flow');
    expect(result.document.metadata.id).toBe(original.metadata.id);
    expect(result.document.nodes).toEqual(original.nodes);
    expect(result.document.edges).toEqual(original.edges);
    expect(result.document.flows).toEqual(original.flows);
    expect(result.document.viewport).toEqual(original.viewport);
    expect(result.document.settings).toEqual(original.settings);
  });

  it('carries a manual routing override through the file format', () => {
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const b = createNode({ type: 'service', x: 400, y: 0 });
    const doc = addEdges(addNodes(createDocument('Routing'), [a, b]), [
      createEdge({ source: a.id, target: b.id, routeMode: 'direct' }),
    ]);
    const result = deserializeDocument(serializeDocument(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Absent means Smart Routing, so silently dropping this on save would
    // hand a connector the user took control of back to the router.
    expect(result.document.edges[0]!.routeMode).toBe('direct');
  });

  it('is byte-stable across repeated writes', () => {
    const doc = richDocument();
    expect(serializeDocument(doc)).toBe(serializeDocument(doc));
  });

  it('survives a second round trip unchanged', () => {
    const once = deserializeDocument(serializeDocument(richDocument()));
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const twice = deserializeDocument(serializeDocument(once.document));
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.document).toEqual(once.document);
  });

  it('preserves code, language and connector details exactly', () => {
    const result = deserializeDocument(serializeDocument(richDocument()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const code = result.document.nodes.find((node) => node.type === 'code')!;
    expect(code.language).toBe('json');
    expect(code.code).toContain('"status": "CANCELLED"');

    const detailed = result.document.edges.find((edge) => edge.details)!;
    expect(detailed.details).toEqual({
      language: 'sql',
      code: 'select * from orders where id = ?',
    });
  });

  it('writes the current schema version', () => {
    expect(JSON.parse(serializeDocument(createDocument())).version).toBe(CURRENT_VERSION);
  });

  it('derives a safe file name from the title', () => {
    expect(fileNameFor('Payment Flow / v2')).toBe('payment-flow-v2.draftcanvas');
    expect(fileNameFor('   ')).toBe('draft-canvas.draftcanvas');
    expect(fileNameFor('Diagram', '.svg')).toBe('diagram.svg');
  });
});
