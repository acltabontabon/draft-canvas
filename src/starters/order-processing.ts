import type { ArchitectureStarter } from './types';

/** A complete small explanation, kept out of the architecture catalog's five primary choices. */
export const ORDER_PROCESSING: ArchitectureStarter = {
  id: 'order-processing', name: 'Order processing', category: 'pattern',
  description: 'Follow an order from the API through a queue to storage.', aliases: ['order example'],
  // One row, lined up by its arrows rather than its top edges: each shape sits so the line through
  // its anchor axis — a service's middle, the queue's tube, the Data Store's glyph — is the same
  // line, and every connector runs straight. (Top-aligned, the tube sat 22 above the services and
  // each arrow took an S-bend with its caption on the short last stub.)
  nodes: [
    { key: 'api', type: 'service', serviceKind: 'api', text: 'Orders API', x: 0, y: 0 },
    { key: 'queue', type: 'queue', queueKind: 'queue', text: 'orders', x: 320, y: 22,
      attachments: [{ type: 'note', text: 'The queue holds accepted work so processing can continue independently of the API request.' }] },
    { key: 'worker', type: 'service', serviceKind: 'worker', text: 'Fulfilment worker', x: 640, y: 0 },
    { key: 'db', type: 'database', text: 'Orders database', x: 960, y: -5 },
  ],
  edges: [
    { key: 'submit', from: 'api', to: 'queue' },
    { key: 'process', from: 'queue', to: 'worker' },
    { key: 'save', from: 'worker', to: 'db' },
  ],
  flows: [{ title: 'Place an order', steps: [
    { edgeKey: 'submit', caption: 'The API accepts an order and queues the work.' },
    { edgeKey: 'process', caption: 'The worker picks up the queued order.' },
    { edgeKey: 'save', caption: 'The worker records the processed order.' },
  ] }],
};
