/**
 * The technology fixes the kind: Redis on a Data Store is a cache, Kafka on a Queue is a stream,
 * Stripe on a Service is something outside the system. A short table of product names, matched the
 * way an outage's product facts match them (`traffic/technology.ts`): the product on its own, with an
 * optional version or parenthetical ("PostgreSQL 16", "Redis (sessions)"), never a stack of several
 * products or a phrase that merely mentions one ("Kafka client").
 */

import type { DatabaseKind, DraftNode, QueueKind, ServiceKind } from './types';

type KindPatch =
  | { type: 'service'; serviceKind: ServiceKind }
  | { type: 'database'; databaseKind: DatabaseKind }
  | { type: 'queue'; queueKind: QueueKind };

// Maps, not plain objects: the key is text the person typed, and "constructor", "__proto__" or
// "toString" on a plain `{}` table finds Object.prototype's function, which then lands in
// `databaseKind` and makes the file impossible to structured-clone (every autosave failed).
const DATABASE = new Map<string, DatabaseKind>();
const QUEUE = new Map<string, QueueKind>();
const SERVICE = new Map<string, ServiceKind>();

function add<K extends string>(table: Map<string, K>, kind: K, names: string[]) {
  for (const name of names) table.set(name, kind);
}

add(DATABASE, 'cache', [
  'redis', 'memcached', 'valkey', 'keydb', 'dragonfly', 'dragonflydb', 'hazelcast', 'elasticache', 'amazon elasticache',
  'aws elasticache', 'memorystore', 'google memorystore', 'azure cache for redis', 'upstash', 'momento',
]);
add(DATABASE, 'sql', [
  'postgresql', 'postgres', 'mysql', 'mariadb', 'sql server', 'microsoft sql server', 'mssql', 'oracle', 'oracle database',
  'sqlite', 'cockroachdb', 'cockroach labs', 'amazon rds', 'aws rds', 'cloud sql', 'google cloud sql', 'aurora',
  'amazon aurora', 'aws aurora', 'azure sql', 'azure sql database', 'spanner', 'cloud spanner', 'google cloud spanner',
  'tidb', 'yugabytedb', 'yugabyte', 'planetscale', 'vitess', 'supabase', 'neon', 'turso', 'timescale', 'timescaledb',
  'singlestore', 'db2', 'ibm db2', 'duckdb',
]);
// Everything that is a system of record without being relational: document, wide-column, key-value,
// graph and time-series stores alike. The kind says "not SQL"; the logo says which.
add(DATABASE, 'nosql', [
  'mongodb', 'mongo', 'dynamodb', 'amazon dynamodb', 'aws dynamodb', 'cassandra', 'apache cassandra', 'couchbase',
  'couchdb', 'firestore', 'cloud firestore', 'cosmos db', 'azure cosmos db', 'cosmosdb', 'scylladb', 'scylla',
  'documentdb', 'amazon documentdb', 'bigtable', 'google bigtable', 'cloud bigtable', 'hbase', 'apache hbase', 'neo4j',
  'amazon neptune', 'neptune', 'arangodb', 'dgraph', 'surrealdb', 'fauna', 'influxdb', 'amazon timestream',
  'timestream', 'etcd',
]);
add(DATABASE, 'object-storage', [
  's3', 'amazon s3', 'aws s3', 'gcs', 'google cloud storage', 'cloud storage', 'azure blob storage', 'azure blob', 'minio',
  'cloudflare r2', 'r2', 'backblaze', 'backblaze b2', 'wasabi', 'digitalocean spaces', 'ceph',
]);
// A hierarchy of files something mounts, as opposed to a bucket something calls.
add(DATABASE, 'file-system', [
  'efs', 'amazon efs', 'aws efs', 'nfs', 'hdfs', 'apache hadoop', 'hadoop', 'azure files', 'filestore',
  'google filestore', 'fsx', 'amazon fsx', 'glusterfs', 'smb', 'sftp', 'ftp',
]);
// A vector database is a search index: it is built from the data and asked for the nearest matches.
add(DATABASE, 'search-index', [
  'elasticsearch', 'opensearch', 'amazon opensearch', 'algolia', 'meilisearch', 'solr', 'apache solr', 'typesense',
  'elastic', 'azure ai search', 'azure cognitive search', 'pinecone', 'qdrant', 'weaviate', 'milvus', 'chroma',
  'chromadb', 'pgvector',
]);
// Data platforms: a lakehouse or warehouse table, the job that refines it, and what schedules it.
add(DATABASE, 'table', [
  'delta lake', 'delta', 'delta table', 'apache iceberg', 'iceberg', 'apache hudi', 'hudi', 'snowflake', 'bigquery',
  'google bigquery', 'redshift', 'amazon redshift', 'azure synapse', 'synapse', 'clickhouse', 'unity catalog',
  'apache druid', 'druid', 'apache pinot', 'pinot', 'apache hive', 'hive',
  'teradata', 'microsoft fabric',
]);
// A topic hands each message to whoever subscribes and is done with it. SNS, Pub/Sub and an event
// bus work that way; so does a broker with no log behind it (core NATS, MQTT).
add(QUEUE, 'topic', [
  'sns', 'amazon sns', 'aws sns', 'pub/sub', 'pubsub', 'google pub/sub', 'cloud pub/sub', 'eventbridge',
  'amazon eventbridge', 'aws eventbridge', 'event grid', 'azure event grid', 'pulsar', 'apache pulsar', 'nats', 'nats.io',
  'mqtt', 'mosquitto', 'eclipse mosquitto', 'emqx', 'hivemq', 'redis pub/sub', 'redis pubsub', 'aws iot core', 'iot core',
]);
// A stream is a retained log each consumer group reads at its own pace, from its own offset. That is
// what a Kafka topic is, whatever Kafka calls it: nothing is delivered and nothing is used up, which
// is why its consumers are "read by" and why it, not a queue per consumer, is what holds an outage.
// Kafka was filed under Topic once, by its own word for a log; the agent skill always said Stream.
add(QUEUE, 'stream', [
  'kafka', 'apache kafka', 'amazon msk', 'aws msk', 'confluent', 'redpanda', 'kinesis', 'amazon kinesis', 'aws kinesis',
  'kinesis data streams', 'event hubs', 'azure event hubs', 'redis streams', 'nats jetstream', 'jetstream',
  'dynamodb streams',
]);
add(QUEUE, 'queue', [
  'sqs', 'amazon sqs', 'aws sqs', 'rabbitmq', 'rabbit mq', 'activemq', 'apache activemq', 'service bus', 'azure service bus',
  'amazon mq', 'ibm mq', 'azure queue storage', 'cloud tasks', 'google cloud tasks', 'beanstalkd', 'bullmq',
]);
// Someone else's system, reached over their API: payments, identity, messaging, the model provider.
add(SERVICE, 'external', [
  'stripe', 'twilio', 'auth0', 'okta', 'sendgrid', 'paypal', 'mailgun', 'plaid', 'adyen', 'braintree', 'postmark',
  'klarna', 'square', 'razorpay', 'wise', 'clerk', 'mailchimp', 'hubspot', 'salesforce', 'zendesk', 'intercom',
  'shopify', 'slack', 'github', 'openai', 'anthropic', 'segment', 'datadog', 'sentry', 'pagerduty', 'google maps',
  'amazon ses', 'aws ses', 'ses',
]);
add(SERVICE, 'worker', [
  'spark', 'apache spark', 'databricks', 'auto loader', 'delta live tables', 'dlt', 'lakeflow', 'dbt', 'flink', 'apache flink',
  'aws glue', 'glue', 'dataflow', 'google dataflow', 'apache beam', 'beam', 'celery', 'sidekiq', 'resque', 'hangfire',
  'kafka streams', 'kafka connect', 'logstash', 'fluentd', 'fluent bit', 'apache nifi', 'nifi', 'airbyte', 'aws batch',
  'apache storm', 'storm',
]);
// What reads a database's own change log and passes each change on (`tailsChangeLog`).
const LOG_TAILERS = [
  'debezium', 'maxwell', 'aws dms', 'dms', 'aws database migration service', 'database migration service', 'datastream',
  'google datastream', 'goldengate', 'oracle goldengate', 'qlik replicate', 'striim',
];
add(SERVICE, 'worker', LOG_TAILERS);
add(SERVICE, 'scheduler', [
  'airflow', 'apache airflow', 'databricks workflows', 'lakeflow jobs', 'dagster', 'prefect', 'cron', 'quartz',
  'cloud scheduler', 'google cloud scheduler', 'eventbridge scheduler', 'amazon eventbridge scheduler', 'kubernetes cronjob',
  'cronjob', 'argo workflows', 'luigi',
]);
add(SERVICE, 'external', ['fivetran']);
add(SERVICE, 'gateway', [
  'kong', 'api gateway', 'amazon api gateway', 'aws api gateway', 'apigee', 'azure api management', 'tyk', 'krakend',
  'zuul', 'spring cloud gateway', 'apollo router', 'apollo gateway', 'aws appsync', 'appsync', 'ambassador', 'emissary',
]);
// What stands in front of services and spreads traffic across their instances, and what stands in
// the path and passes it along. Products that do several of these jobs are filed under the one they
// are best known for; the kind is one click away when a diagram means another.
add(SERVICE, 'load-balancer', [
  'haproxy', 'elb', 'aws elb', 'elastic load balancing', 'alb', 'aws alb', 'application load balancer', 'nlb', 'aws nlb',
  'network load balancer', 'azure load balancer', 'cloud load balancing', 'google cloud load balancing', 'f5', 'metallb',
  'azure application gateway', 'azure front door',
]);
add(SERVICE, 'proxy', [
  'nginx', 'envoy', 'traefik', 'caddy', 'squid', 'varnish', 'cloudflare', 'cloudfront', 'amazon cloudfront', 'aws cloudfront',
  'fastly', 'akamai', 'istio', 'linkerd', 'bunny.net', 'bunny cdn', 'azure cdn', 'cloud cdn', 'google cloud cdn', 'pgbouncer',
  'proxysql', 'ngrok',
]);

/** The product a technology names on its own: lower case, single-spaced, without a trailing
 *  version ("16", "v3.2") or parenthetical. `null` for a stack ("Kafka + Redis", "Go, Postgres"). */
export function productOf(technology: string): string | null {
  let text = technology.trim().toLowerCase().replace(/\s+/g, ' ');
  text = text.replace(/\s*\([^)]*\)\s*$/, '');
  text = text.replace(/\s+v?\d+(?:\.\d+)*$/, '');
  if (!text || /[+,&;|]|\band\b|\bwith\b/.test(text)) return null;
  return text;
}

/**
 * Whether a Service's technology is a change-data-capture tool: something that tails a database's
 * log rather than querying it, so the arrow from that database is its changes streaming out
 * (`connectorSemantics.ts`'s `refinementBetween`).
 */
export function tailsChangeLog(technology: string | undefined): boolean {
  const product = technology ? productOf(technology) : null;
  return product !== null && LOG_TAILERS.includes(product);
}

/** The kind `technology` implies for a shape of `type`, if this table knows one. */
export function kindForTechnology(type: DraftNode['type'], technology: string | undefined): KindPatch | null {
  if (!technology) return null;
  const product = productOf(technology);
  if (!product) return null;
  if (type === 'database') {
    const databaseKind = DATABASE.get(product);
    if (databaseKind) return { type, databaseKind };
  }
  if (type === 'queue') {
    const queueKind = QUEUE.get(product);
    if (queueKind) return { type, queueKind };
  }
  if (type === 'service') {
    const serviceKind = SERVICE.get(product);
    if (serviceKind) return { type, serviceKind };
  }
  return null;
}

/**
 * The shape a technology is, where this table knows it on its own: Kafka is a Queue (a stream), Redis
 * a Data Store (a cache), Stripe a Service (external). `null` for a technology that is what shapes
 * are built with rather than a shape itself (Go, Spring Boot), or one the table has never heard of.
 */
export function shapeForTechnology(technology: string | undefined): KindPatch | null {
  return kindForTechnology('database', technology) ?? kindForTechnology('queue', technology) ?? kindForTechnology('service', technology);
}

const DEFAULT_KIND = { service: 'generic', database: 'generic', queue: 'queue' } as const;

/**
 * What a new shape of `type` made *as* a technology starts with: the technology, and the kind it
 * implies — marked as following the technology, exactly as if the shape had been drawn first and
 * the technology typed onto it, so changing the technology later still moves the kind.
 */
export function technologyStart(
  type: DraftNode['type'],
  technology: string,
): { technology: string } & Partial<Pick<DraftNode, 'serviceKind' | 'databaseKind' | 'queueKind' | 'kindOrigin'>> {
  return { technology, ...technologyKindPatch({ type } as DraftNode, technology) };
}

/**
 * The kind fields a technology change should write, or `null` to leave the kind alone. A kind is
 * only ever moved off its type's default, or off a kind an earlier technology set
 * (`kindOrigin: 'technology'`) — never off one the person picked. Clearing or replacing that
 * technology with one this table doesn't know puts such a kind back to the default.
 * A dead-letter queue stays a queue: that role only belongs to one.
 */
export function technologyKindPatch(node: DraftNode, technology: string | undefined): Partial<DraftNode> | null {
  if (node.type !== 'service' && node.type !== 'database' && node.type !== 'queue') return null;
  if (node.deliveryRole) return null;
  const field = node.type === 'service' ? 'serviceKind' : node.type === 'database' ? 'databaseKind' : 'queueKind';
  const current = node[field] ?? DEFAULT_KIND[node.type];
  const followsTechnology = node.kindOrigin === 'technology';
  if (current !== DEFAULT_KIND[node.type] && !followsTechnology) return null;
  const implied = kindForTechnology(node.type, technology);
  if (implied) {
    const kind = (implied as Record<string, string>)[field]!;
    if (kind === current && (followsTechnology || kind === DEFAULT_KIND[node.type])) return null;
    return { [field]: kind, kindOrigin: kind === DEFAULT_KIND[node.type] ? undefined : 'technology' } as Partial<DraftNode>;
  }
  if (!followsTechnology) return null;
  return { [field]: DEFAULT_KIND[node.type], kindOrigin: undefined } as Partial<DraftNode>;
}
