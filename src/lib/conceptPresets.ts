import {
  ACTOR_KIND_OPTION_LABELS,
  ARTIFACT_KIND_OPTION_LABELS,
  BOUNDARY_PRESET_OPTION_LABELS,
  COMPONENT_KIND_OPTION_LABELS,
  DATABASE_KIND_OPTION_LABELS,
  QUEUE_KIND_OPTION_LABELS,
  SERVICE_KIND_OPTION_LABELS,
} from './nodeKindLabels';
import { ALL_PRESETS, type Preset, type PresetStart } from './presets';

/**
 * The things people draw, by the names they call them.
 *
 * The rail holds eight shapes and the vocabulary underneath it is deliberately small: a handful of
 * types, each with a few kinds. But nobody sets out to draw "a Service of kind Load Balancer" —
 * they set out to draw a load balancer, a CDN, a config file, a TLS certificate. This table is the
 * bridge: each entry is a name someone would type, and the existing shape and kind it means. Picked,
 * it lands already set to that kind, and already named when the name is more specific than the kind
 * ("CDN" is a Proxy called CDN).
 *
 * It adds no vocabulary. Every entry resolves to a type and kind `document/types.ts` already has,
 * so a file made with these is the same file as one made the long way round (shape, then kind, then
 * name). That is also the rule for what belongs here versus in `types.ts`: a new *kind* has to
 * change how the shape draws or what it may say to its neighbours; anything a kind plus a name can
 * already say is one more row in this table. None of it is on the rail or in a menu: it is found
 * by typing, in the shape picker and in the command palette.
 */
interface Concept {
  /** What it is called, and what the row reads. Also the shape's name when `named` is set. */
  label: string;
  type: Preset['type'];
  start?: PresetStart;
  /** The label is more specific than the kind, so the shape arrives carrying it. */
  named?: true;
  /** One line on what it is, for the row's tooltip and the palette. */
  description: string;
  /** Other things people type for it. Matched from the start of a word. */
  keywords: string[];
}

const CONCEPTS: Concept[] = [
  // Service kinds, each by its own name.
  { label: 'API', type: 'service', start: { serviceKind: 'api' }, description: 'A service whose main job is serving an API.', keywords: ['rest', 'graphql', 'grpc', 'endpoint', 'backend'] },
  { label: 'Worker', type: 'service', start: { serviceKind: 'worker' }, description: 'A background process that works through a queue or a batch.', keywords: ['consumer', 'job', 'background', 'processor', 'batch'] },
  { label: 'Scheduler', type: 'service', start: { serviceKind: 'scheduler' }, description: 'Something that starts work on a schedule.', keywords: ['cron', 'timer', 'schedule'] },
  { label: 'Gateway', type: 'service', start: { serviceKind: 'gateway' }, description: 'The front door: authenticates, rate-limits and routes each request.', keywords: ['api gateway', 'edge', 'router', 'entry'] },
  { label: 'Load Balancer', type: 'service', start: { serviceKind: 'load-balancer' }, description: 'Spreads requests across several instances of the same thing.', keywords: ['lb', 'alb', 'nlb', 'elb', 'balancer', 'l4', 'l7', 'traffic', 'failover'] },
  { label: 'Proxy', type: 'service', start: { serviceKind: 'proxy' }, description: 'Stands in the path of traffic and passes it along.', keywords: ['intermediary', 'forwarder', 'tunnel'] },
  { label: 'External System', type: 'service', start: { serviceKind: 'external' }, description: 'A system outside the one being described.', keywords: ['third party', 'saas', 'vendor', 'partner', 'outside'] },

  // What a Proxy, a Gateway or a Service is usually called.
  { label: 'Reverse Proxy', type: 'service', start: { serviceKind: 'proxy' }, named: true, description: 'A proxy in front of your services: clients talk to it, not to them.', keywords: ['nginx', 'tls termination', 'ssl termination', 'edge'] },
  { label: 'Forward Proxy', type: 'service', start: { serviceKind: 'proxy' }, named: true, description: 'A proxy your services call out through.', keywords: ['egress', 'outbound', 'squid', 'http proxy'] },
  { label: 'CDN', type: 'service', start: { serviceKind: 'proxy' }, named: true, description: 'A content delivery network: an edge proxy that caches close to the client.', keywords: ['content delivery network', 'edge cache', 'static assets'] },
  { label: 'WAF', type: 'service', start: { serviceKind: 'proxy' }, named: true, description: 'A web application firewall inspecting requests on the way in.', keywords: ['web application firewall', 'firewall', 'filter'] },
  { label: 'Firewall', type: 'service', start: { serviceKind: 'proxy' }, named: true, description: 'Decides which traffic may pass.', keywords: ['network policy', 'security group', 'packet filter'] },
  { label: 'Sidecar', type: 'service', start: { serviceKind: 'proxy' }, named: true, description: 'A helper that runs beside one service and handles its traffic. Draw both inside a Pod.', keywords: ['service mesh', 'mesh', 'envoy', 'istio', 'linkerd', 'dapr'] },
  { label: 'Ingress', type: 'service', start: { serviceKind: 'gateway' }, named: true, description: 'Where traffic enters a cluster and is routed by host and path.', keywords: ['ingress controller', 'kubernetes', 'k8s', 'entry'] },
  { label: 'BFF', type: 'service', start: { serviceKind: 'api' }, named: true, description: 'A backend for one frontend: composes the services its screens need.', keywords: ['backend for frontend', 'aggregator'] },
  { label: 'Identity Provider', type: 'service', start: { serviceKind: 'external' }, named: true, description: 'Signs people in and issues the tokens services trust.', keywords: ['idp', 'sso', 'auth', 'authentication', 'oauth', 'oidc', 'saml', 'login'] },
  { label: 'Cron Job', type: 'service', start: { serviceKind: 'scheduler' }, named: true, description: 'A job that runs at set times.', keywords: ['cronjob', 'nightly', 'periodic'] },
  { label: 'Function', type: 'service', start: { serviceKind: 'generic' }, named: true, description: 'A serverless function: runs when called, then goes away.', keywords: ['serverless', 'lambda', 'faas', 'cloud function'] },
  { label: 'Web App', type: 'service', start: { serviceKind: 'generic' }, named: true, description: 'The browser application people use.', keywords: ['frontend', 'spa', 'website', 'browser', 'ui', 'client'] },
  { label: 'Mobile App', type: 'service', start: { serviceKind: 'generic' }, named: true, description: 'The phone or tablet application people use.', keywords: ['ios', 'android', 'phone', 'frontend', 'client'] },

  // Data Store kinds, and their common names.
  { label: 'SQL Database', type: 'database', start: { databaseKind: 'sql' }, description: 'A relational database.', keywords: ['relational', 'rdbms', 'database', 'db'] },
  { label: 'NoSQL Database', type: 'database', start: { databaseKind: 'nosql' }, description: 'A document, key-value or wide-column store.', keywords: ['document store', 'key value', 'kv', 'wide column', 'database', 'db'] },
  { label: 'Cache', type: 'database', start: { databaseKind: 'cache' }, description: 'Keeps recent answers close so they are not worked out again.', keywords: ['in memory', 'session store'] },
  { label: 'File System', type: 'database', start: { databaseKind: 'file-system' }, description: 'A file system or shared volume.', keywords: ['volume', 'disk', 'nfs', 'folder', 'directory', 'mount'] },
  { label: 'Object Storage', type: 'database', start: { databaseKind: 'object-storage' }, description: 'Buckets of files, addressed by key.', keywords: ['bucket', 'blob', 'blob storage'] },
  { label: 'Search Index', type: 'database', start: { databaseKind: 'search-index' }, description: 'An index built for searching.', keywords: ['full text', 'search engine', 'inverted index'] },
  { label: 'Table', type: 'database', start: { databaseKind: 'table' }, description: 'One table, when the tables themselves are the subject.', keywords: ['collection', 'outbox', 'read model', 'projection'] },
  { label: 'Data Lake', type: 'database', start: { databaseKind: 'object-storage' }, named: true, description: 'Raw data kept as files, to be refined later.', keywords: ['lake', 'lakehouse', 'raw zone'] },
  { label: 'Data Warehouse', type: 'database', start: { databaseKind: 'sql' }, named: true, description: 'Where refined data is kept for analysis.', keywords: ['warehouse', 'analytics', 'olap', 'dwh'] },
  { label: 'Secrets Manager', type: 'database', start: { databaseKind: 'generic' }, named: true, description: 'Where secrets and keys are kept and handed out.', keywords: ['vault', 'kms', 'key management', 'secret store', 'keystore'] },
  { label: 'Container Registry', type: 'database', start: { databaseKind: 'object-storage' }, named: true, description: 'Where built images are pushed and pulled from.', keywords: ['registry', 'image registry', 'artifact repository', 'docker hub', 'ecr'] },

  // Queue kinds.
  { label: 'Topic', type: 'queue', start: { queueKind: 'topic' }, description: 'Every subscriber gets every message.', keywords: ['pub/sub', 'pubsub', 'publish subscribe', 'fan out'] },
  { label: 'Stream', type: 'queue', start: { queueKind: 'stream' }, description: 'An ordered log that consumers read at their own pace.', keywords: ['event stream', 'log', 'partition'] },
  { label: 'Event Bus', type: 'queue', start: { queueKind: 'topic' }, named: true, description: 'The shared channel events are published to.', keywords: ['bus', 'message bus', 'broker', 'message broker'] },

  // Actor kinds.
  { label: 'AI Agent', type: 'actor', start: { actorKind: 'agent' }, description: 'A machine that decides what to do next on someone’s behalf.', keywords: ['llm', 'assistant', 'chatbot', 'bot', 'copilot'] },
  { label: 'Device', type: 'actor', start: { actorKind: 'device' }, description: 'A phone, sensor or other device taking part.', keywords: ['iot', 'sensor', 'phone', 'mobile', 'hardware'] },
  { label: 'User Group', type: 'actor', start: { actorKind: 'group' }, description: 'Several people acting together: a team, a segment.', keywords: ['team', 'users', 'people', 'segment', 'audience'] },
  { label: 'Third Party', type: 'actor', start: { actorKind: 'thirdParty' }, description: 'A person or organisation outside your own.', keywords: ['vendor', 'partner', 'supplier', 'organisation', 'organization', 'company'] },
  { label: 'System Actor', type: 'actor', start: { actorKind: 'system' }, description: 'Another system acting as a participant.', keywords: ['machine', 'client system', 'service account'] },

  // Component kinds.
  { label: 'Module', type: 'component', start: { componentKind: 'module' }, description: 'An internal subdivision of one deployment.', keywords: ['package', 'library', 'namespace'] },
  { label: 'Adapter', type: 'component', start: { componentKind: 'adapter' }, description: 'Translates between the core and something outside it.', keywords: ['hexagonal', 'driver', 'connector', 'anti-corruption'] },
  { label: 'Port', type: 'component', start: { componentKind: 'port' }, description: 'A contract: an interface one side defines and the other implements.', keywords: ['interface', 'contract', 'hexagonal'] },

  // Artifact kinds, and the files people actually name.
  { label: 'File', type: 'artifact', start: { artifactKind: 'file' }, description: 'A file that matters to the story.', keywords: ['document', 'report', 'export', 'csv', 'pdf'] },
  { label: 'Config', type: 'artifact', start: { artifactKind: 'config' }, description: 'The settings a service starts with.', keywords: ['configuration', 'settings', 'yaml', 'json', 'toml', 'properties', 'configmap'] },
  { label: 'Secret', type: 'artifact', start: { artifactKind: 'secret' }, description: 'Something a service is handed and must never show.', keywords: ['credential', 'credentials', 'password', 'key', 'keys'] },
  { label: 'Certificate', type: 'artifact', start: { artifactKind: 'certificate' }, description: 'What a service presents to prove who it is.', keywords: ['cert', 'x509', 'x.509', 'pem', 'ca', 'trust'] },
  { label: 'Env File', type: 'artifact', start: { artifactKind: 'config' }, named: true, description: 'Environment variables a service starts with.', keywords: ['.env', 'dotenv', 'environment variables', 'env vars'] },
  { label: 'Feature Flags', type: 'artifact', start: { artifactKind: 'config' }, named: true, description: 'Switches that turn behaviour on and off without a deploy.', keywords: ['flag', 'toggle', 'feature toggle', 'rollout'] },
  { label: 'Manifest', type: 'artifact', start: { artifactKind: 'config' }, named: true, description: 'A deployment described as a file.', keywords: ['helm chart', 'chart', 'kubernetes', 'k8s', 'terraform', 'infrastructure as code', 'iac', 'compose'] },
  { label: 'API Key', type: 'artifact', start: { artifactKind: 'secret' }, named: true, description: 'A key that identifies a caller to an API.', keywords: ['apikey', 'access key', 'client secret'] },
  { label: 'Token', type: 'artifact', start: { artifactKind: 'secret' }, named: true, description: 'A token a caller presents with each request.', keywords: ['jwt', 'access token', 'bearer', 'refresh token', 'session'] },
  { label: 'Private Key', type: 'artifact', start: { artifactKind: 'secret' }, named: true, description: 'The half of a key pair that is never shared.', keywords: ['ssh key', 'signing key', 'key pair', 'keypair', 'rsa'] },
  { label: 'TLS Certificate', type: 'artifact', start: { artifactKind: 'certificate' }, named: true, description: 'The certificate a server presents for HTTPS.', keywords: ['ssl', 'ssl certificate', 'https', 'mtls', 'cert'] },
  { label: 'Container Image', type: 'artifact', start: { artifactKind: 'file' }, named: true, description: 'A built, shippable image of a service.', keywords: ['docker image', 'image', 'build artifact', 'oci'] },
  { label: 'Dockerfile', type: 'artifact', start: { artifactKind: 'file' }, named: true, description: 'The recipe an image is built from.', keywords: ['containerfile', 'build file'] },
  { label: 'Schema', type: 'artifact', start: { artifactKind: 'file' }, named: true, description: 'The agreed shape of a message or an API.', keywords: ['openapi', 'swagger', 'protobuf', 'proto', 'avro', 'contract', 'idl'] },
  { label: 'Log File', type: 'artifact', start: { artifactKind: 'file' }, named: true, description: 'What a service writes down as it runs.', keywords: ['logs', 'audit log', 'access log'] },

  // Boundaries people ask for by name.
  { label: 'Pod', type: 'group', start: { boundaryPreset: 'deployment' }, named: true, description: 'Containers deployed together: a service and its sidecars.', keywords: ['kubernetes', 'k8s', 'sidecar', 'containers', 'deployment'] },
  { label: 'Cluster', type: 'group', start: { boundaryPreset: 'deployment' }, named: true, description: 'Everything that runs in one cluster.', keywords: ['kubernetes', 'k8s', 'ecs', 'nodes'] },
  { label: 'VPC', type: 'group', start: { boundaryPreset: 'network' }, named: true, description: 'One private network.', keywords: ['virtual private cloud', 'vnet', 'private network', 'subnet'] },
  { label: 'DMZ', type: 'group', start: { boundaryPreset: 'network' }, named: true, description: 'The network zone between the internet and the inside.', keywords: ['perimeter', 'public subnet', 'edge network'] },
  { label: 'Region', type: 'group', start: { boundaryPreset: 'deployment' }, named: true, description: 'Everything that runs in one region.', keywords: ['availability zone', 'az', 'datacenter', 'data center'] },
];

const KIND_LABEL = (concept: Concept): string | undefined => {
  const start = concept.start ?? {};
  if (start.serviceKind) return SERVICE_KIND_OPTION_LABELS[start.serviceKind];
  if (start.databaseKind) return DATABASE_KIND_OPTION_LABELS[start.databaseKind];
  if (start.queueKind) return QUEUE_KIND_OPTION_LABELS[start.queueKind];
  if (start.actorKind) return ACTOR_KIND_OPTION_LABELS[start.actorKind];
  if (start.componentKind) return COMPONENT_KIND_OPTION_LABELS[start.componentKind];
  if (start.artifactKind) return ARTIFACT_KIND_OPTION_LABELS[start.artifactKind];
  if (start.boundaryPreset) return BOUNDARY_PRESET_OPTION_LABELS[start.boundaryPreset];
  return undefined;
};

const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function presetOf(concept: Concept): Preset {
  const base = ALL_PRESETS.find((preset) => preset.type === concept.type)!;
  const kind = KIND_LABEL(concept);
  // "Generic" is the absence of a kind, not one worth reading out.
  const hint = kind && kind !== 'Generic' ? `${base.label} · ${kind}` : base.label;
  return {
    id: `concept:${slug(concept.label)}`,
    label: concept.label,
    type: concept.type,
    shortcut: '',
    hint,
    description: concept.description,
    // The two Service kinds that are a picture of their own show it; the rest show their family's.
    glyph: concept.start?.serviceKind === 'load-balancer' || concept.start?.serviceKind === 'proxy' ? concept.start.serviceKind : base.id,
    start: concept.start,
    ...(concept.named ? { text: concept.label } : {}),
  };
}

interface Entry {
  preset: Preset;
  name: string;
  nameWords: string[];
  keywords: string[];
}

const wordsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9.+#/]+/).filter(Boolean);

const ENTRIES: Entry[] = CONCEPTS.map((concept) => ({
  preset: presetOf(concept),
  name: concept.label.toLowerCase(),
  nameWords: wordsOf(concept.label),
  keywords: concept.keywords.map((keyword) => keyword.toLowerCase()),
}));

/** Every concept, as presets: what the command palette lists as "Add …". */
export const CONCEPT_PRESETS: Preset[] = ENTRIES.map((entry) => entry.preset);

/** The other names a concept answers to, for the palette's own matcher. */
export function conceptKeywords(preset: Preset): string[] {
  return ENTRIES.find((entry) => entry.preset.id === preset.id)?.keywords ?? [];
}

/** A few good answers, not the table. */
const LIMIT = 6;

/**
 * The concepts `query` names, best first. Every word typed has to start a word of the name or of
 * one of its other names ("rev pro" is a Reverse Proxy; "tls" is a TLS Certificate): "contains
 * these letters" finds far too much in a table this size. A name is a better answer than an alias,
 * and a name that starts with what was typed better than one that has it further in.
 */
export function conceptShapes(query: string): Preset[] {
  const typed = wordsOf(query);
  if (typed.length === 0 || typed.join('').length < 2) return [];
  const whole = typed.join(' ');
  const ranked: { preset: Preset; rank: number; order: number }[] = [];
  ENTRIES.forEach((entry, order) => {
    const inName = typed.every((word) => entry.nameWords.some((candidate) => candidate.startsWith(word)));
    const keyword = entry.keywords.find((candidate) => {
      const parts = wordsOf(candidate);
      return typed.every((word) => parts.some((part) => part.startsWith(word)));
    });
    if (!inName && keyword === undefined) return;
    const rank = entry.name === whole ? 0 : entry.name.startsWith(whole) ? 1 : inName ? 2 : keyword === whole ? 3 : 4;
    ranked.push({ preset: entry.preset, rank, order });
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, LIMIT)
    .map((entry) => entry.preset);
}
