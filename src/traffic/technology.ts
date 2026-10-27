import type { DraftNode } from '../document/types';

// Curated product facts, not deployment detection. Sources are maintained in the Traffic guide.
// Match only assigned product names and optional numeric versions: never infer from labels,
// substrings such as "Kafka client", or a stack containing several products.
const NOTES = [
  { name: 'PostgreSQL', aliases: ['postgresql', 'postgres'], type: 'database', text: 'Indexes can help reads and add write overhead. These logical operations do not estimate query cost or disk I/O.' },
  { name: 'MySQL', aliases: ['mysql'], type: 'database', text: 'Indexes can help reads and add write overhead. These logical operations do not estimate query cost or disk I/O.' },
  { name: 'MongoDB', aliases: ['mongodb', 'mongo'], type: 'database', text: 'Writes can also update indexes. Document size and affected indexes are not shown in these operation counts.' },
  { name: 'Redis', aliases: ['redis'], type: 'database', text: 'Memory limits and eviction policy affect what happens when memory fills. Neither is established by these operation counts.' },
  { name: 'DynamoDB', aliases: ['dynamodb', 'amazon dynamodb', 'aws dynamodb'], type: 'database', text: 'Item size, read consistency and transaction use affect capacity consumed. These operation counts are not capacity units.' },
  { name: 'Kafka', aliases: ['kafka', 'apache kafka'], type: 'queue', text: 'Consumer groups determine which consumers share work or receive separate copies. Groups and filters are not shown; delivery counts remain illustrative.' },
  { name: 'RabbitMQ', aliases: ['rabbitmq', 'rabbit mq'], type: 'queue', text: 'Acknowledgements and publisher confirms cover different stages. Backpressure can affect publishers; settings are not shown.' },
  { name: 'Amazon SQS', aliases: ['sqs', 'amazon sqs', 'aws sqs'], type: 'queue', text: 'Standard queues can deliver duplicates. Queue type and retry settings are not inferred; the example counts each modeled delivery once.' },
  { name: 'Amazon SNS', aliases: ['sns', 'amazon sns', 'aws sns'], type: 'queue', text: 'Subscription filters can change who receives a message. Filters and delivery retries are not shown; fan-out counts remain illustrative.' },
] as const;

export function technologyNote(node: Pick<DraftNode, 'type' | 'technology'>) {
  const assigned = node.technology?.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!assigned) return null;
  const product = assigned.replace(/\s+v?\d+(?:\.\d+)*$/, '');
  const note = NOTES.find((item) => item.type === node.type && item.aliases.some((alias) => alias === product));
  return note ? { name: note.name, text: note.text } : null;
}
