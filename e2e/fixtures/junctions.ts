import { node, type OutageDocument } from './outage';

const edge = (id: string, source: string, target: string, extra: Record<string, unknown> = {}) => ({ id, source, target, directed: true, routing: 'smoothstep', ...extra });

const junction = (id: string, x: number, y: number, label: string, link: string, parentId: string) => ({ id, type: 'ellipse', x, y, width: 36, height: 36, z: 0, text: label, link, parentId });

const section = (id: string, title: string, x: number, y: number, width: number, height: number) => ({ id, type: 'group', x, y, width, height, z: 0, text: title, boundaryPreset: 'domain' });

/**
 * A payment drawn in the parts it happens in, far enough apart that a connector between them would
 * cross the whole diagram. The parts are joined by linked Junctions instead: **A** is drawn in four
 * places (initiation, execution, reconciliation and event processing), **B** in two that sit close
 * together. What the guide's pictures of following a Junction are taken from.
 */
export function paymentsDocument(): OutageDocument {
  return {
    format: 'draft-canvas',
    version: 33,
    metadata: { id: 'payments-by-junction', title: 'Payments', createdAt: 1, updatedAt: 2 },
    nodes: [
      section('initiation', 'Payment Initiation', 0, 0, 1000, 330),
      node('customer', 'actor', 'Customer', 60, 110, { width: 120, height: 110, actorKind: 'human', parentId: 'initiation' }),
      node('checkout', 'service', 'Checkout API', 260, 123, { serviceKind: 'api', parentId: 'initiation' }),
      node('orders', 'service', 'Order Service', 540, 123, { parentId: 'initiation' }),
      junction('a-initiation', 840, 147, 'A', 'payment', 'initiation'),
      junction('b-initiation', 612, 262, 'B', 'notify', 'initiation'),

      section('notifications', 'Notifications', 0, 480, 880, 270),
      junction('b-notifications', 70, 600, 'B', 'notify', 'notifications'),
      node('notifier', 'service', 'Notification Service', 220, 576, { parentId: 'notifications' }),
      node('email', 'service', 'Email Provider', 560, 560, { serviceKind: 'external', height: 114, parentId: 'notifications' }),

      section('execution', 'Payment Execution', 2800, 300, 960, 330),
      junction('a-execution', 2870, 447, 'A', 'payment', 'execution'),
      node('adapter', 'service', 'Partner Adapter', 3020, 423, { parentId: 'execution' }),
      node('gateway', 'service', 'External Gateway', 3360, 408, { serviceKind: 'external', height: 114, parentId: 'execution' }),

      section('reconciliation', 'Reconciliation', 300, 2100, 960, 330),
      junction('a-reconciliation', 370, 2247, 'A', 'payment', 'reconciliation'),
      node('reconciler', 'service', 'Reconciliation Service', 520, 2208, { serviceKind: 'worker', height: 114, parentId: 'reconciliation' }),
      node('ledger', 'database', 'Ledger', 900, 2215, { databaseKind: 'sql', parentId: 'reconciliation' }),

      section('events', 'Event Processing', 3100, 2300, 960, 330),
      junction('a-events', 3170, 2447, 'A', 'payment', 'events'),
      node('consumer', 'service', 'Kafka Consumer', 3320, 2408, { serviceKind: 'worker', height: 114, parentId: 'events' }),
      node('topic', 'queue', 'payment-events', 3680, 2429, { queueKind: 'topic', width: 200, height: 72, parentId: 'events' }),
    ],
    edges: [
      edge('customer-checkout', 'customer', 'checkout'),
      edge('checkout-orders', 'checkout', 'orders'),
      edge('orders-a', 'orders', 'a-initiation'),
      edge('orders-b', 'orders', 'b-initiation'),
      edge('b-notifier', 'b-notifications', 'notifier'),
      edge('notifier-email', 'notifier', 'email'),
      edge('a-adapter', 'a-execution', 'adapter'),
      edge('adapter-gateway', 'adapter', 'gateway'),
      edge('a-reconciler', 'a-reconciliation', 'reconciler'),
      edge('reconciler-ledger', 'reconciler', 'ledger'),
      edge('a-consumer', 'a-events', 'consumer'),
      edge('consumer-topic', 'consumer', 'topic'),
    ],
    viewport: { x: 170, y: 96, zoom: 0.92 },
    settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
    flows: [],
  };
}
