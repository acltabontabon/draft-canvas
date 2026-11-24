import { productOf } from '../document/technologyKind';
import type { DraftNode } from '../document/types';

/**
 * What a named product does with work while something is down — curated product behaviour, not
 * deployment detection. Each line is the product's documented default; a setting that changes it
 * is the person's to know, which is why an outage note adds the fact and never drops its question.
 *
 * Every sentence names the page of the vendor's own documentation it was read from and the day it
 * was last checked against it, and an outage note carries that source with the sentence. A fact
 * with no page to point at does not belong here: `tests/traffic/technology.test.ts` holds that
 * line. Re-check a fact by reading its page, then move its `checked` date.
 *
 * Match only an assigned product name with an optional version or parenthetical (`productOf`, the
 * rule a technology's kind follows): never infer from labels, substrings such as "Kafka client", or
 * a stack naming several products.
 */
export interface OutageFact {
  name: string;
  /** Keeps what arrives for a consumer that is down. `false`: it is dropped once delivery gives up. */
  retains?: boolean;
  /** Said when it stands in front of something down or failing. */
  holding?: string;
  /** Said when it is the thing that is down. */
  down?: string;
  /** The vendor's page each sentence was read from, and through it `retains`. */
  sources: { holding?: string; down?: string };
  /** The day the sentences were last read against those pages, as `YYYY-MM-DD`. */
  checked: string;
}

/** Where a sentence in an outage note comes from: the product, and its vendor's page. */
export interface OutageSource {
  name: string;
  url: string;
}

/** The source to carry with one of a fact's sentences, when the fact has that sentence. */
export function sourceOf(fact: OutageFact | null | undefined, sentence: 'holding' | 'down'): OutageSource[] | undefined {
  const url = fact?.[sentence] ? fact.sources[sentence] : undefined;
  return fact && url ? [{ name: fact.name, url }] : undefined;
}

export const OUTAGE_FACTS: readonly (OutageFact & { aliases: readonly string[]; type: DraftNode['type'] })[] = [
  {
    name: 'Kafka',
    // Managed and wire-compatible Kafka keeps the log the same way.
    aliases: ['kafka', 'apache kafka', 'amazon msk', 'aws msk', 'confluent', 'redpanda'],
    type: 'queue',
    retains: true,
    holding: 'Kafka keeps events for the topic\'s retention period whether or not anyone has read them, so a consumer that returns can read what it missed.',
    sources: { holding: 'https://kafka.apache.org/intro' },
    checked: '2026-11-23',
  },
  {
    name: 'RabbitMQ',
    aliases: ['rabbitmq', 'rabbit mq'],
    type: 'queue',
    retains: true,
    holding: 'RabbitMQ keeps a message in its queue until a consumer acknowledges it, and hands unacknowledged ones out again.',
    down: 'Only durable queues and persistent messages survive a RabbitMQ broker restart.',
    sources: { holding: 'https://www.rabbitmq.com/docs/confirms', down: 'https://www.rabbitmq.com/docs/queues#durability' },
    checked: '2026-11-23',
  },
  {
    name: 'Amazon SQS',
    aliases: ['sqs', 'amazon sqs', 'aws sqs'],
    type: 'queue',
    retains: true,
    holding: 'Amazon SQS keeps a message for its retention period (four days unless changed) and shows it again after each visibility timeout.',
    sources: { holding: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html' },
    checked: '2026-11-23',
  },
  {
    name: 'Amazon SNS',
    aliases: ['sns', 'amazon sns', 'aws sns'],
    type: 'queue',
    retains: false,
    holding: 'Amazon SNS retries a delivery and then drops the message, unless the subscription has its own dead-letter queue.',
    sources: { holding: 'https://docs.aws.amazon.com/sns/latest/dg/sns-dead-letter-queues.html' },
    checked: '2026-11-23',
  },
  {
    name: 'Azure Service Bus',
    aliases: ['service bus', 'azure service bus'],
    type: 'queue',
    retains: true,
    holding: 'Azure Service Bus keeps a message until it is completed or its time to live runs out, and moves it to the dead-letter subqueue after ten failed deliveries unless that count is changed.',
    sources: { holding: 'https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-dead-letter-queues' },
    checked: '2026-11-23',
  },
  {
    name: 'Google Pub/Sub',
    aliases: ['pub/sub', 'pubsub', 'google pub/sub', 'cloud pub/sub'],
    type: 'queue',
    retains: true,
    holding: 'Google Pub/Sub keeps an unacknowledged message on its subscription for seven days unless changed, and delivers it again after each acknowledgement deadline.',
    sources: { holding: 'https://cloud.google.com/pubsub/docs/subscription-properties' },
    checked: '2026-11-23',
  },
  {
    name: 'Apache Pulsar',
    aliases: ['pulsar', 'apache pulsar'],
    type: 'queue',
    retains: true,
    holding: 'Apache Pulsar keeps every message a subscription has not acknowledged, so a subscriber that already exists picks up where it stopped.',
    sources: { holding: 'https://pulsar.apache.org/docs/next/cookbooks-retention-expiry/' },
    checked: '2026-11-23',
  },
  {
    name: 'Amazon Kinesis',
    aliases: ['kinesis', 'amazon kinesis', 'aws kinesis', 'kinesis data streams'],
    type: 'queue',
    retains: true,
    holding: 'Amazon Kinesis keeps a record for 24 hours unless retention is extended, so a consumer down for longer than that loses what it had not read.',
    sources: { holding: 'https://docs.aws.amazon.com/streams/latest/dev/kinesis-extended-retention.html' },
    checked: '2026-11-23',
  },
  {
    name: 'Amazon EventBridge',
    aliases: ['eventbridge', 'amazon eventbridge', 'aws eventbridge'],
    type: 'queue',
    retains: false,
    holding: 'Amazon EventBridge retries a delivery for up to 24 hours and then drops the event, unless the target has its own dead-letter queue.',
    sources: { holding: 'https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rule-retry-policy.html' },
    checked: '2026-11-23',
  },
  {
    name: 'Azure Event Grid',
    aliases: ['event grid', 'azure event grid'],
    type: 'queue',
    retains: false,
    holding: 'Azure Event Grid retries a delivery for up to 24 hours and then drops the event, unless dead-lettering is set up on the subscription.',
    sources: { holding: 'https://learn.microsoft.com/en-us/azure/event-grid/delivery-and-retry' },
    checked: '2026-11-23',
  },
  {
    name: 'NATS',
    aliases: ['nats', 'nats.io'],
    type: 'queue',
    retains: false,
    holding: 'Core NATS delivers at most once: a subscriber that is not connected never sees the message, unless the subject is kept by JetStream.',
    sources: { holding: 'https://docs.nats.io/nats-concepts/core-nats' },
    checked: '2026-11-23',
  },
  {
    name: 'MQTT',
    aliases: ['mqtt', 'mosquitto', 'eclipse mosquitto', 'emqx', 'hivemq'],
    type: 'queue',
    retains: false,
    holding: 'An MQTT broker drops what an offline subscriber misses, unless it connected with a persistent session and subscribed at QoS 1 or 2.',
    sources: { holding: 'https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/os/mqtt-v3.1.1-os.html' },
    checked: '2026-11-23',
  },
  {
    name: 'Redis Pub/Sub',
    aliases: ['redis pub/sub', 'redis pubsub'],
    type: 'queue',
    retains: false,
    holding: 'Redis Pub/Sub keeps nothing: a message goes to whoever is subscribed at that moment and is gone.',
    sources: { holding: 'https://redis.io/docs/latest/develop/pubsub/' },
    checked: '2026-11-23',
  },
  {
    name: 'Valkey',
    aliases: ['valkey'],
    type: 'database',
    down: 'Valkey saves snapshots to disk by default and reloads the last one when it restarts: writes since then are gone, and with persistence off it comes back empty.',
    sources: { down: 'https://valkey.io/topics/persistence/' },
    checked: '2026-11-23',
  },
  {
    name: 'Redis',
    aliases: ['redis'],
    type: 'database',
    down: 'Redis saves snapshots to disk by default and reloads the last one when it restarts: writes since then are gone, and with persistence off it comes back empty.',
    sources: { down: 'https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/' },
    checked: '2026-11-23',
  },
  {
    name: 'Memcached',
    aliases: ['memcached'],
    type: 'database',
    down: 'Memcached comes back empty after a restart, so everything is a miss until it warms up again, unless it was started for a warm restart and shut down cleanly.',
    sources: { down: 'https://docs.memcached.org/features/restart/' },
    checked: '2026-11-23',
  },
];

export function outageFact(node: Pick<DraftNode, 'type' | 'technology'> | undefined): OutageFact | null {
  const product = node?.technology ? productOf(node.technology) : null;
  if (!node || !product) return null;
  return OUTAGE_FACTS.find((item) => item.type === node.type && item.aliases.some((alias) => alias === product)) ?? null;
}
