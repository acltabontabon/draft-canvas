import { createDocument, createEdge, createNode } from '../../../src/document/factory';

/** The checkout diagram that exposed overlapping replies, a false fork and a tiny ledger jog. */
export function connectorStyleDocument() {
  const document = createDocument('Checkout — a quiet conversation');
  document.metadata.id = 'd_connectorstyle';
  document.settings.showSequence = false;
  document.nodes = [
    createNode({ id: 'web', type: 'service', text: 'Storefront', x: 0, y: 210, width: 144, height: 80 }),
    createNode({ id: 'gateway', type: 'service', text: 'Checkout API', x: 250, y: 210, width: 160, height: 80 }),
    createNode({ id: 'orders', type: 'service', text: 'Order Service', x: 535, y: 50, width: 160, height: 80 }),
    createNode({ id: 'payments', type: 'service', text: 'Payment Service', x: 535, y: 370, width: 160, height: 80 }),
    createNode({ id: 'events', type: 'queue', text: 'Order Events', x: 840, y: 50, width: 160, height: 80 }),
    createNode({ id: 'audit', type: 'service', text: 'Audit Log', x: 840, y: 210, width: 160, height: 80 }),
    createNode({ id: 'ledger', type: 'database', text: 'Payment Ledger', x: 840, y: 370, width: 160, height: 80 }),
  ];
  document.edges = [
    createEdge({ id: 'request', source: 'web', target: 'gateway', semantic: 'calls', label: 'POST /checkout' }),
    createEdge({ id: 'create', source: 'gateway', target: 'orders', semantic: 'calls', label: 'Create order' }),
    { ...createEdge({ id: 'authorize', source: 'gateway', target: 'payments', semantic: 'calls', label: 'Authorize', hasResponse: true }), response: 'Approved' },
    createEdge({ id: 'publish', source: 'orders', target: 'events', semantic: 'publishes', kind: 'event', label: 'Order placed' }),
    createEdge({ id: 'audit-call', source: 'gateway', target: 'audit', semantic: 'calls', label: 'Write audit trail' }),
    createEdge({ id: 'record', source: 'payments', target: 'ledger', semantic: 'writes', label: 'Record payment' }),
  ];
  return document;
}
