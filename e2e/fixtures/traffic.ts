export type TrafficDocument = {
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

export function trafficDocument(title = 'Traffic journey'): TrafficDocument {
  return {
    format: 'draft-canvas',
    version: 22,
    metadata: { id: 'traffic-journey', title, createdAt: 1, updatedAt: 2 },
    nodes: [
      node('gateway', 'service', 'API Gateway', 0, 0, { serviceKind: 'gateway' }),
      node('mobile', 'service', 'Mobile App API', 0, 220),
      node('checkout', 'service', 'Checkout', 360, 100),
      node('billing', 'service', 'Billing', 720, 0),
      node('postgres', 'database', 'PostgreSQL', 720, 240, { databaseKind: 'sql' }),
      node('note', 'note', 'A note outside runtime traffic', 380, 360, { noteKind: 'note' }),
    ],
    edges: [
      { id: 'gateway-checkout', source: 'gateway', target: 'checkout', directed: true, routing: 'smoothstep', semantic: 'calls' },
      { id: 'mobile-checkout', source: 'mobile', target: 'checkout', directed: true, routing: 'smoothstep', semantic: 'calls' },
      { id: 'checkout-postgres', source: 'checkout', target: 'postgres', directed: true, routing: 'smoothstep', semantic: 'readsWrites' },
      { id: 'billing-postgres', source: 'billing', target: 'postgres', directed: true, routing: 'smoothstep', semantic: 'readsWrites' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
    flows: [],
  };
}

export function notesOnlyDocument(): TrafficDocument {
  const document = trafficDocument('Notes only');
  return { ...document, nodes: [node('note', 'note', 'Only a note', 0, 0)], edges: [] };
}


export function recoveryDocument(): TrafficDocument {
  const document = trafficDocument('Recovery work');
  return { ...document, nodes: [
    node('api', 'service', 'API', 0, 0),
    node('worker', 'service', 'Worker', 340, 0),
    node('db', 'database', 'Database', 680, 0),
    node('dlq', 'queue', 'Dead-letter queue', 340, 240, { deliveryRole: 'dead-letter' }),
  ], edges: [
    { id: 'call', source: 'api', target: 'worker', semantic: 'calls', directed: true },
    { id: 'write', source: 'worker', target: 'db', semantic: 'writes', directed: true },
    { id: 'dead', source: 'worker', target: 'dlq', semantic: 'deadLetters', directed: true },
    { id: 'replay', source: 'dlq', target: 'worker', semantic: 'deliversTo', directed: true },
  ] };
}

export function boundaryDocument(): TrafficDocument {
  const document = recoveryDocument();
  document.nodes = [node('deployment', 'group', 'Processing deployment', 300, -60, { width: 600, height: 200, boundaryPreset: 'deployment' }), ...document.nodes.map((item) => item.id === 'worker' || item.id === 'db' ? { ...item, parentId: 'deployment' } : item)];
  document.edges.push({ id: 'read', source: 'api', target: 'db', semantic: 'reads', directed: true });
  return document;
}
