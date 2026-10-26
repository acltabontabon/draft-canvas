import { createDocument, createEdge, createNode } from '../../../src/document/factory';

/** Public agent input for the same geometry, without pins or manual routing instructions. */
export function nearbyServicesRequest() {
  const doc = nearbyServicesDocument();
  return {
    title: 'MCP nearby services',
    nodes: doc.nodes.map(n => ({ id: n.id, type: 'service', label: n.text!, place: { x: n.x, y: n.y, width: n.width, height: n.height } })),
    relationships: doc.edges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  };
}

/** Nearby, slightly offset services: a fixed bottom-to-top connector used to loop around them. */
export function nearbyServicesDocument(pinned = false) {
  const document = createDocument('Nearby services');
  document.metadata.id = 'd_nearbyservices';
  document.settings.showSequence = false;
  document.nodes = [
    createNode({ id: 'source', type: 'service', text: 'Service A', x: 0, y: 0, width: 350, height: 134 }),
    createNode({ id: 'near', type: 'service', text: 'Service B', x: 410, y: 41, width: 350, height: 134 }),
    createNode({ id: 'far', type: 'service', text: 'Service C', x: 776, y: 0, width: 350, height: 134 }),
  ];
  document.edges = [
    createEdge({
      id: 'nearby', source: 'source', target: 'near', semantic: 'calls', label: 'Connect',
      ...(pinned ? { sourceAnchor: { side: 'bottom' as const, offset: 0.5 }, targetAnchor: { side: 'top' as const, offset: 0.5 } } : {}),
    }),
    createEdge({ id: 'through', source: 'source', target: 'far', semantic: 'calls' }),
  ];
  return document;
}
