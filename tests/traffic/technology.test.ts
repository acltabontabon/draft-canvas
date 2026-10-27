import { describe, expect, it } from 'vitest';
import { technologyNote } from '../../src/traffic/technology';

describe('technology notes', () => {
  it.each(['PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Amazon DynamoDB'])('recognizes assigned database %s', (technology) => {
    expect(technologyNote({ type: 'database', technology })).not.toBeNull();
  });
  it.each(['Apache Kafka', 'RabbitMQ', 'AWS SQS', 'Amazon SNS'])('recognizes assigned messaging %s', (technology) => {
    expect(technologyNote({ type: 'queue', technology })).not.toBeNull();
  });
  it('accepts aliases, spacing and numeric versions', () => {
    expect(technologyNote({ type: 'database', technology: '  Postgres   v16.2 ' })?.name).toBe('PostgreSQL');
    expect(technologyNote({ type: 'queue', technology: 'sns' })?.name).toBe('Amazon SNS');
  });
  it.each([undefined, '', 'Private runtime', 'Kafka client', 'Redis + PostgreSQL', 'not redis', 'Amazon SQS FIFO'])('does not guess from ambiguous or custom text %s', (technology) => {
    expect(technologyNote({ type: 'database', technology })).toBeNull();
    expect(technologyNote({ type: 'queue', technology })).toBeNull();
  });
  it('does not treat a service using a client library as the infrastructure product', () => {
    expect(technologyNote({ type: 'service', technology: 'Kafka' })).toBeNull();
    expect(technologyNote({ type: 'queue', technology: 'PostgreSQL' })).toBeNull();
  });
});
