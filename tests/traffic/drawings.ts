import { createEdge, createNode } from '../../src/document/factory';
import type { DraftEdge, DraftFlow, DraftNode } from '../../src/document/types';

/** Seeded, so a failure names the drawing that caused it. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Drawing {
  nodes: DraftNode[];
  edges: DraftEdge[];
  flows: DraftFlow[];
}

/**
 * An ordinary microservice landscape of about `total` shapes: people, gateways, services (some with
 * three instances), queues and topics, dead-letter queues, workers, stores and caches, in zones, with
 * about two connectors a shape — mostly calls forward, the odd one back — and ten flows.
 */
export function landscape(total: number, seed = 7): Drawing {
  const next = random(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
  const nodes: DraftNode[] = [];
  const edges: DraftEdge[] = [];
  const connect = (source: string, target: string, semantic: DraftEdge['semantic']) => {
    edges.push(createEdge({ id: `e${edges.length}`, source, target, semantic }));
  };
  const zones: string[] = [];
  for (let index = 0; index < Math.max(1, Math.floor(total / 40)); index += 1) {
    zones.push(`zone${index}`);
    nodes.push(createNode({ id: `zone${index}`, type: 'group', x: index * 2000, y: 0, width: 1800, height: 1800, text: `Zone ${index}` }));
  }
  const rest = total - zones.length;
  const add = (prefix: string, share: number, make: (id: string, index: number) => DraftNode): string[] => {
    const ids: string[] = [];
    for (let index = 0; index < Math.max(1, Math.floor(rest * share)); index += 1) {
      const id = `${prefix}${index}`;
      ids.push(id);
      nodes.push({ ...make(id, index), parentId: pick(zones) });
    }
    return ids;
  };
  const people = add('actor', 0.03, (id, index) => createNode({ id, type: 'actor', x: index * 10, y: 0, text: `User ${index}` }));
  const gateways = add('gw', 0.03, (id, index) => createNode({ id, type: 'service', serviceKind: 'gateway', x: index * 10, y: 100, text: `Gateway ${index}` }));
  const services = add('svc', 0.4, (id, index) => ({ ...createNode({ id, type: 'service', x: index * 10, y: 200, text: `Service ${index}` }), ...(index % 7 === 0 ? { replicas: 3 } : {}) }));
  const queues = add('q', 0.1, (id, index) =>
    createNode({ id, type: 'queue', queueKind: index % 4 === 0 ? 'topic' : 'queue', x: index * 10, y: 300, text: `Queue ${index}`, ...(index % 3 === 0 ? { technology: 'Kafka' } : {}) }),
  );
  const deadLetters = add('dlq', 0.03, (id, index) => createNode({ id, type: 'queue', deliveryRole: 'dead-letter', x: index * 10, y: 350, text: `DLQ ${index}` }));
  const workers = add('wk', 0.15, (id, index) => createNode({ id, type: 'service', serviceKind: 'worker', x: index * 10, y: 400, text: `Worker ${index}` }));
  const stores = add('db', 0.2, (id, index) => createNode({ id, type: 'database', databaseKind: index % 5 === 0 ? 'cache' : 'sql', x: index * 10, y: 500, text: `Store ${index}` }));
  for (const person of people) connect(person, pick(gateways), 'calls');
  for (const gateway of gateways) for (let k = 0; k < 4; k += 1) connect(gateway, pick(services), 'routes');
  services.forEach((service, index) => {
    for (let k = 0; k < 2; k += 1) {
      const later = index + 1 + Math.floor(next() * 30);
      if (later < services.length) connect(service, services[later]!, 'calls');
    }
    if (next() < 0.05 && index > 5) connect(service, services[index - 1 - Math.floor(next() * 5)]!, 'calls');
    connect(service, pick(stores), next() < 0.5 ? 'reads' : 'writes');
    if (next() < 0.4) connect(service, pick(queues), 'publishes');
  });
  queues.forEach((queue, index) => {
    connect(queue, pick(workers), 'consumes');
    if (index % 3 === 0) connect(queue, pick(deadLetters), 'deadLetters');
  });
  for (const worker of workers) {
    connect(worker, pick(stores), 'writes');
    if (next() < 0.5) connect(worker, pick(services), 'calls');
  }
  const flows: DraftFlow[] = Array.from({ length: 10 }, (_, flow) => ({
    id: `f${flow}`,
    title: `Flow ${flow}`,
    steps: Array.from({ length: 12 }, (_, step) => ({ id: `f${flow}s${step}`, edgeId: pick(edges).id })),
  }));
  return { nodes, edges, flows };
}

/**
 * A small drawing that tries every rule at once: loops and self-loops, Junctions, nested
 * Boundaries and a malformed parent loop, caches, topics drawn as products, dead-letter routes,
 * fallbacks, retries, recovery actions, calls nobody waits on, instances, outside systems,
 * schedulers, multi-line names, and flows that name connectors, shapes and nothing at all.
 */
export function tangle(seed: number, size: number): Drawing {
  const next = random(seed);
  const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
  const kinds: Array<() => Partial<DraftNode> & Pick<DraftNode, 'type'>> = [
    () => ({ type: 'actor' }),
    () => ({ type: 'service' }),
    () => ({ type: 'service', replicas: 2 }),
    () => ({ type: 'service', serviceKind: 'worker' }),
    () => ({ type: 'service', serviceKind: 'gateway' }),
    () => ({ type: 'service', serviceKind: 'external' }),
    () => ({ type: 'service', serviceKind: 'scheduler' }),
    () => ({ type: 'database', databaseKind: 'sql' }),
    () => ({ type: 'database', databaseKind: 'cache', ...(next() < 0.5 ? { technology: 'Redis' } : {}) }),
    () => ({ type: 'queue' }),
    () => ({ type: 'queue', queueKind: 'topic', ...(next() < 0.5 ? { technology: pick(['Kafka', 'Amazon SNS']) } : {}) }),
    () => ({ type: 'queue', queueKind: 'stream' }),
    () => ({ type: 'queue', deliveryRole: 'dead-letter' }),
    () => ({ type: 'ellipse' }),
    () => ({ type: 'component' }),
  ];
  const nodes: DraftNode[] = [
    createNode({ id: 'g0', type: 'group', x: 0, y: 0, text: 'Zone A' }),
    { ...createNode({ id: 'g1', type: 'group', x: 0, y: 0, text: 'Zone B' }), parentId: 'g0' },
    { ...createNode({ id: 'g2', type: 'group', x: 0, y: 0, text: 'Zone C' }), ...(next() < 0.3 ? { parentId: 'g2' } : {}) },
  ];
  for (let index = 0; index < size; index += 1) {
    const { type, ...rest } = pick(kinds)();
    const roll = next();
    const text = roll < 0.1 ? undefined : roll < 0.2 ? `Name ${index}\n\n\nover lines` : `N${index}`;
    nodes.push({ ...createNode({ id: `n${index}`, type, x: index * 10, y: 0, ...(text === undefined ? {} : { text }) }), ...rest, ...(next() < 0.35 ? { parentId: pick(['g0', 'g1', 'g2']) } : {}) });
  }
  const ids = nodes.filter((node) => node.type !== 'group').map((node) => node.id);
  const semantics: Array<DraftEdge['semantic']> = [undefined, 'calls', 'calls', 'calls', 'reads', 'writes', 'readsWrites', 'publishes', 'consumes', 'deliversTo', 'deadLetters', 'routes', 'command', 'query', 'indexes', 'invalidates', 'compensates', 'dependsOn'];
  const edges: DraftEdge[] = [];
  for (let index = 0; index < Math.floor(size * (1.2 + next() * 1.3)); index += 1) {
    const source = pick(ids);
    const semantic = pick(semantics);
    const edge = createEdge({ id: `e${index}`, source, target: next() < 0.04 ? source : pick(ids), ...(semantic ? { semantic } : {}) });
    const roll = next();
    if (roll < 0.08) edge.kind = 'fallback';
    else if (roll < 0.14) edge.kind = 'retry';
    else if (roll < 0.18) edge.kind = 'failure';
    if (next() < 0.15) edge.async = true;
    if (next() < 0.05) edge.deliveryAttempts = 1 + Math.floor(next() * 5);
    edges.push(edge);
  }
  for (const edge of [...edges]) {
    if ((edge.semantic === 'writes' || edge.semantic === 'command') && next() < 0.3) {
      edges.push({ ...createEdge({ id: `${edge.id}-undo`, source: edge.source, target: edge.target, semantic: 'compensates' }), compensationFor: edge.id, ...(next() < 0.5 ? { compensationName: 'Undo it' } : {}) });
    }
  }
  const flows: DraftFlow[] = Array.from({ length: Math.floor(next() * 4) }, (_, flow) => ({
    id: `f${flow}`,
    title: next() < 0.2 ? '  ' : `Flow ${flow}`,
    steps: Array.from({ length: 1 + Math.floor(next() * 6) }, (_, step) => ({
      id: `f${flow}s${step}`,
      ...(next() < 0.9 ? { edgeId: edges.length > 0 ? pick(edges).id : 'none' } : {}),
      ...(next() < 0.15 ? { extraEdgeIds: [edges.length > 0 ? pick(edges).id : 'none'] } : {}),
      ...(next() < 0.1 ? { extraNodeIds: [pick(ids)] } : {}),
    })),
  }));
  return { nodes, edges, flows };
}
