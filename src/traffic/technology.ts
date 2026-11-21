import type { DraftNode } from '../document/types';

/**
 * What a named product does with work while something is down — curated product behaviour, not
 * deployment detection. Each line is the product's documented default; a setting that changes it
 * is the person's to know, which is why an outage note adds the fact and never drops its question.
 *
 * Match only an assigned product name with an optional numeric version: never infer from labels,
 * substrings such as "Kafka client", or a stack naming several products.
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
    aliases: ['kafka', 'apache kafka'],
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
  const assigned = node?.technology?.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!node || !assigned) return null;
  const product = assigned.replace(/\s+v?\d+(?:\.\d+)*$/, '');
  return FACTS.find((item) => item.type === node.type && item.aliases.some((alias) => alias === product)) ?? null;
}
