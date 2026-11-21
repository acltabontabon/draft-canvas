export type OutageDocument = {
  format: 'draft-canvas';
  version: number;
  metadata: { id: string; title: string; createdAt: number; updatedAt: number };
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  viewport: { x: number; y: number; zoom: number };
  settings: { showSequence: boolean; grid: 'dots'; background: { enabled: boolean; fit: 'cover'; dim: number; blur: number } };
  flows: [];
};

export const node = (id: string, type: string, text: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  x,
  y,
  width: type === 'database' ? 176 : 180,
  height: type === 'note' ? 80 : 84,
  z: 0,
  text,
  ...extra,
});

const edge = (id: string, source: string, target: string, semantic: string, extra: Record<string, unknown> = {}) => ({
  id,
  source,
  target,
  directed: true,
  routing: 'smoothstep',
  semantic,
  ...extra,
});

/**
 * An online store drawn to be taken apart: a synchronous chain from the shopper to the orders
 * database, a cache in front of the catalog, and an order queue feeding a worker that calls a
 * payment provider — with a dead-letter queue but no way back out of it.
 */
export function storeDocument(title = 'Online store'): OutageDocument {
  return {
    format: 'draft-canvas',
    version: 22,
    metadata: { id: 'online-store', title, createdAt: 1, updatedAt: 2 },
    nodes: [
      node('shopper', 'actor', 'Shopper', 0, 150, { width: 120, height: 110, actorKind: 'human' }),
      node('storefront', 'service', 'Storefront', 240, 160, { serviceKind: 'api' }),
      node('cache', 'database', 'Product cache', 560, -40, { databaseKind: 'cache', technology: 'Redis' }),
      node('catalog', 'database', 'Catalog', 860, -40, { databaseKind: 'sql', technology: 'PostgreSQL' }),
      node('checkout', 'service', 'Checkout', 560, 160, { replicas: 2 }),
      node('orders-db', 'database', 'Orders', 860, 160, { databaseKind: 'sql', technology: 'PostgreSQL' }),
      node('orders', 'queue', 'Order events', 560, 400, { queueKind: 'queue', technology: 'Amazon SQS', width: 200, height: 72 }),
      node('fulfilment', 'service', 'Fulfilment', 860, 394, { serviceKind: 'worker' }),
      node('payments', 'service', 'Payment provider', 1180, 394, { serviceKind: 'external' }),
      node('dlq', 'queue', '', 560, 600, { queueKind: 'queue', deliveryRole: 'dead-letter', width: 200, height: 72 }),
      node('note', 'note', 'Peak season starts in November', 0, 420, { noteKind: 'note' }),
    ],
    edges: [
      edge('shopper-storefront', 'shopper', 'storefront', 'calls'),
      edge('storefront-cache', 'storefront', 'cache', 'reads'),
      edge('storefront-catalog', 'storefront', 'catalog', 'reads'),
      edge('storefront-checkout', 'storefront', 'checkout', 'calls'),
      edge('checkout-orders-db', 'checkout', 'orders-db', 'writes'),
      edge('checkout-orders', 'checkout', 'orders', 'publishes', { async: true }),
      edge('orders-fulfilment', 'orders', 'fulfilment', 'consumes', { async: true }),
      edge('fulfilment-payments', 'fulfilment', 'payments', 'calls'),
      edge('orders-dlq', 'orders', 'dlq', 'deadLetters', { kind: 'failure', async: true, deliveryAttempts: 3 }),
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
    flows: [],
  };
}

export function notesOnlyDocument(): OutageDocument {
  return { ...storeDocument('Notes only'), nodes: [node('note', 'note', 'Only a note', 0, 0)], edges: [] };
}
