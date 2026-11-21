import { productOf } from '../document/technologyKind';
import type { DraftNode } from '../document/types';

/**
 * What a named product does with work while something is down — curated product behaviour, not
 * deployment detection. Each line is the product's documented default; a setting that changes it
 * is the person's to know, which is why an outage note adds the fact and never drops its question.
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
}

const FACTS: readonly (OutageFact & { aliases: readonly string[]; type: DraftNode['type'] })[] = [
  {
    name: 'Kafka',
    // Managed and wire-compatible Kafka keeps the log the same way.
    aliases: ['kafka', 'apache kafka', 'amazon msk', 'aws msk', 'confluent', 'redpanda'],
    type: 'queue',
    retains: true,
    holding: 'Kafka keeps the log for its retention period whether or not anyone is reading, and a consumer group picks up from its last committed offset.',
  },
  {
    name: 'RabbitMQ',
    aliases: ['rabbitmq', 'rabbit mq'],
    type: 'queue',
    retains: true,
    holding: 'RabbitMQ keeps a message in its queue until a consumer acknowledges it, and hands unacknowledged ones out again.',
    down: 'Only durable queues and persistent messages survive a RabbitMQ broker restart.',
  },
  {
    name: 'Amazon SQS',
    aliases: ['sqs', 'amazon sqs', 'aws sqs'],
    type: 'queue',
    retains: true,
    holding: 'Amazon SQS keeps a message for its retention period (four days unless changed) and shows it again after each visibility timeout.',
  },
  {
    name: 'Amazon SNS',
    aliases: ['sns', 'amazon sns', 'aws sns'],
    type: 'queue',
    retains: false,
    holding: 'Amazon SNS retries a delivery and then drops the message, unless the subscription has its own dead-letter queue.',
  },
  {
    name: 'Azure Service Bus',
    aliases: ['service bus', 'azure service bus'],
    type: 'queue',
    retains: true,
    holding: 'Azure Service Bus keeps a message until it is completed or its time to live runs out, and moves it to the dead-letter subqueue after ten failed deliveries unless that count is changed.',
  },
  {
    name: 'Google Pub/Sub',
    aliases: ['pub/sub', 'pubsub', 'google pub/sub', 'cloud pub/sub'],
    type: 'queue',
    retains: true,
    holding: 'Google Pub/Sub keeps an unacknowledged message on its subscription for seven days unless changed, and delivers it again after each acknowledgement deadline.',
  },
  {
    name: 'Apache Pulsar',
    aliases: ['pulsar', 'apache pulsar'],
    type: 'queue',
    retains: true,
    holding: 'Apache Pulsar keeps every message a subscription has not acknowledged, so a subscriber that already exists picks up where it stopped.',
  },
  {
    name: 'Amazon Kinesis',
    aliases: ['kinesis', 'amazon kinesis', 'aws kinesis', 'kinesis data streams'],
    type: 'queue',
    retains: true,
    holding: 'Amazon Kinesis keeps a record for 24 hours unless retention is extended, so a consumer down for longer than that loses what it had not read.',
  },
  {
    name: 'Amazon EventBridge',
    aliases: ['eventbridge', 'amazon eventbridge', 'aws eventbridge'],
    type: 'queue',
    retains: false,
    holding: 'Amazon EventBridge retries a delivery for up to 24 hours and then drops the event, unless the target has its own dead-letter queue.',
  },
  {
    name: 'Azure Event Grid',
    aliases: ['event grid', 'azure event grid'],
    type: 'queue',
    retains: false,
    holding: 'Azure Event Grid retries a delivery for up to 24 hours and then drops the event, unless dead-lettering is set up on the subscription.',
  },
  {
    name: 'NATS',
    aliases: ['nats', 'nats.io'],
    type: 'queue',
    retains: false,
    holding: 'Core NATS delivers at most once: a subscriber that is not connected never sees the message, unless the subject is kept by JetStream.',
  },
  {
    name: 'MQTT',
    aliases: ['mqtt', 'mosquitto', 'eclipse mosquitto', 'emqx', 'hivemq'],
    type: 'queue',
    retains: false,
    holding: 'An MQTT broker drops what an offline subscriber misses, unless it connected with a persistent session and subscribed at QoS 1 or 2.',
  },
  {
    name: 'Redis Pub/Sub',
    aliases: ['redis pub/sub', 'redis pubsub'],
    type: 'queue',
    retains: false,
    holding: 'Redis Pub/Sub keeps nothing: a message goes to whoever is subscribed at that moment and is gone.',
  },
  {
    name: 'Valkey',
    aliases: ['valkey'],
    type: 'database',
    down: 'Valkey comes back empty unless persistence is on, so everything is a miss until it warms up again.',
  },
  {
    name: 'Redis',
    aliases: ['redis'],
    type: 'database',
    down: 'Redis comes back empty unless persistence is on, so everything is a miss until it warms up again.',
  },
  {
    name: 'Memcached',
    aliases: ['memcached'],
    type: 'database',
    down: 'Memcached keeps nothing across a restart, so everything is a miss until it warms up again.',
  },
];

export function outageFact(node: Pick<DraftNode, 'type' | 'technology'> | undefined): OutageFact | null {
  const product = node?.technology ? productOf(node.technology) : null;
  if (!node || !product) return null;
  return FACTS.find((item) => item.type === node.type && item.aliases.some((alias) => alias === product)) ?? null;
}
