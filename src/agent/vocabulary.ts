/**
 * The words an agent uses for shapes, and the native fields each one means.
 *
 * A native shape is a `type` plus a kind field (`serviceKind`, `databaseKind`, …). An agent names it
 * with one word — `api`, `topic`, `person` — because that is how a diagram is described out loud and
 * because it makes a common request readable without a catalog lookup. Every word maps onto native
 * fields and back again; nothing here is a type of its own, and nothing is stored that the editor
 * doesn't already understand.
 */

import type {
  ActorKind,
  BoundaryPreset,
  ComponentKind,
  DatabaseKind,
  DraftNode,
  DraftNodeType,
  QueueKind,
  ServiceKind,
} from '../document/types';

export interface NativeShape {
  type: DraftNodeType;
  serviceKind?: ServiceKind;
  databaseKind?: DatabaseKind;
  queueKind?: QueueKind;
  actorKind?: ActorKind;
  componentKind?: ComponentKind;
  deliveryRole?: 'dead-letter';
}

/** Every element type an agent may ask for, with what it is natively. Order is the order capabilities list them in. */
export const ELEMENT_TYPES: Record<string, NativeShape & { summary: string }> = {
  service: { type: 'service', serviceKind: 'generic', summary: 'An application or service (C4: a software system at context level, a container at container level).' },
  api: { type: 'service', serviceKind: 'api', summary: 'A service whose main job is serving an API.' },
  worker: { type: 'service', serviceKind: 'worker', summary: 'A background worker or consumer process.' },
  scheduler: { type: 'service', serviceKind: 'scheduler', summary: 'A scheduled job or cron runner.' },
  gateway: { type: 'service', serviceKind: 'gateway', summary: 'An API gateway, load balancer or ingress.' },
  'external-system': { type: 'service', serviceKind: 'external', summary: 'A software system outside the one being described.' },
  database: { type: 'database', databaseKind: 'generic', summary: 'A data store, kind unspecified.' },
  'sql-database': { type: 'database', databaseKind: 'sql', summary: 'A relational database.' },
  'nosql-database': { type: 'database', databaseKind: 'nosql', summary: 'A document, key-value or wide-column store.' },
  cache: { type: 'database', databaseKind: 'cache', summary: 'A cache (Redis, Memcached…).' },
  'file-system': { type: 'database', databaseKind: 'file-system', summary: 'A file system or shared volume.' },
  'object-storage': { type: 'database', databaseKind: 'object-storage', summary: 'Object storage (S3, GCS, Blob…).' },
  'search-index': { type: 'database', databaseKind: 'search-index', summary: 'A search index (Elasticsearch, OpenSearch…).' },
  table: { type: 'database', databaseKind: 'table', summary: 'One table, when the tables themselves are the subject.' },
  queue: { type: 'queue', queueKind: 'queue', summary: 'A point-to-point message queue.' },
  topic: { type: 'queue', queueKind: 'topic', summary: 'A publish/subscribe topic (SNS, Kafka topic…).' },
  stream: { type: 'queue', queueKind: 'stream', summary: 'An ordered event stream or log.' },
  'dead-letter-queue': { type: 'queue', queueKind: 'queue', deliveryRole: 'dead-letter', summary: 'Where undeliverable messages go.' },
  person: { type: 'actor', actorKind: 'human', summary: 'A user or role (C4: a person).' },
  'user-group': { type: 'actor', actorKind: 'group', summary: 'A group of people, a team or department.' },
  'external-actor': { type: 'actor', actorKind: 'thirdParty', summary: 'A third party acting on the system (a partner, a payment provider).' },
  'system-actor': { type: 'actor', actorKind: 'system', summary: 'Another system as an actor that starts interactions.' },
  device: { type: 'actor', actorKind: 'device', summary: 'A device (a phone, a sensor, a terminal).' },
  component: { type: 'component', componentKind: 'generic', summary: 'A component inside a container (C4 component level).' },
  module: { type: 'component', componentKind: 'module', summary: 'A module or package.' },
  adapter: { type: 'component', componentKind: 'adapter', summary: 'An adapter (hexagonal architecture).' },
  port: { type: 'component', componentKind: 'port', summary: 'A port (hexagonal architecture).' },
  junction: { type: 'ellipse', summary: 'A small routing point where connectors meet or split.' },
};

/** The words agents reach for without looking anything up, mapped to the real ones. */
const ALIASES: Record<string, string> = {
  microservice: 'service',
  application: 'service',
  app: 'service',
  backend: 'service',
  'web-app': 'service',
  frontend: 'service',
  spa: 'service',
  lambda: 'worker',
  function: 'worker',
  consumer: 'worker',
  job: 'scheduler',
  cron: 'scheduler',
  'load-balancer': 'gateway',
  'api-gateway': 'gateway',
  external: 'external-system',
  'external-service': 'external-system',
  'software-system': 'service',
  system: 'service',
  db: 'database',
  datastore: 'database',
  'data-store': 'database',
  sql: 'sql-database',
  postgres: 'sql-database',
  mysql: 'sql-database',
  nosql: 'nosql-database',
  'document-store': 'nosql-database',
  redis: 'cache',
  s3: 'object-storage',
  bucket: 'object-storage',
  elasticsearch: 'search-index',
  'message-queue': 'queue',
  sqs: 'queue',
  sns: 'topic',
  'kafka-topic': 'topic',
  kafka: 'stream',
  'event-stream': 'stream',
  dlq: 'dead-letter-queue',
  user: 'person',
  actor: 'person',
  human: 'person',
  team: 'user-group',
  'third-party': 'external-actor',
};

export const ELEMENT_TYPE_NAMES = Object.keys(ELEMENT_TYPES);

export function resolveType(word: string): NativeShape | undefined {
  const key = word.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const direct = ELEMENT_TYPES[key] ?? ELEMENT_TYPES[ALIASES[key] ?? ''];
  if (!direct) return undefined;
  const { summary: _summary, ...shape } = direct;
  return shape;
}

/** Up to three real type names nearest to an unknown word, for the error that refuses it. */
export function suggestTypes(word: string): string[] {
  const key = word.trim().toLowerCase();
  const scored = [...ELEMENT_TYPE_NAMES, ...Object.keys(ALIASES)].map((name) => ({ name, d: distance(key, name) }));
  scored.sort((a, b) => a.d - b.d || a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const { name } of scored) {
    const real = ELEMENT_TYPES[name] ? name : ALIASES[name];
    if (real && !out.includes(real)) out.push(real);
    if (out.length === 3) break;
  }
  return out;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] as number;
      row[j] = Math.min(current + 1, (row[j - 1] as number) + 1, (previous as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length] as number;
}

/** The agent's word for a native shape — the inverse of `resolveType`, used when reading. */
export function typeWordOf(node: DraftNode): string {
  switch (node.type) {
    case 'service':
      return node.serviceKind === 'external' ? 'external-system' : node.serviceKind && node.serviceKind !== 'generic' ? node.serviceKind : 'service';
    case 'database': {
      const kind = node.databaseKind ?? 'generic';
      if (kind === 'generic') return 'database';
      if (kind === 'sql') return 'sql-database';
      if (kind === 'nosql') return 'nosql-database';
      return kind;
    }
    case 'queue':
      if (node.deliveryRole === 'dead-letter') return 'dead-letter-queue';
      return node.queueKind ?? 'queue';
    case 'actor': {
      const kind = node.actorKind ?? 'human';
      return kind === 'human' ? 'person' : kind === 'group' ? 'user-group' : kind === 'thirdParty' ? 'external-actor' : kind === 'system' ? 'system-actor' : 'device';
    }
    case 'component':
      return node.componentKind && node.componentKind !== 'generic' ? node.componentKind : 'component';
    case 'ellipse':
      return 'junction';
    default:
      return node.type;
  }
}

/** Boundary kinds, by the names agents use. Only `system` is a C4 software-system boundary. */
export const GROUP_KINDS: Record<string, { preset: BoundaryPreset; summary: string }> = {
  system: { preset: 'system', summary: 'A software system boundary (C4): what is inside is part of that system.' },
  domain: { preset: 'domain', summary: 'A business domain or bounded context.' },
  network: { preset: 'network', summary: 'A network zone (VPC, subnet, DMZ).' },
  deployment: { preset: 'deployment', summary: 'A deployment environment or node (a cluster, a region).' },
  group: { preset: 'group', summary: 'A plain visual grouping with no architectural meaning.' },
  boundary: { preset: 'boundary', summary: 'A titled boundary with no preset caption.' },
};

export function groupKindOf(preset: BoundaryPreset | undefined): string {
  return preset ?? 'boundary';
}

export const NOTE_KIND_NAMES = ['note', 'question', 'warning', 'decision'] as const;
