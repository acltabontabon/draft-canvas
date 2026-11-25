import { describe, expect, it } from 'vitest';
import { analyzeTraffic, outageOf } from '../../src/traffic';
import { OUTAGE_FACTS, outageFact, sourceOf } from '../../src/traffic/technology';
import { edge, node } from './helpers';

/*
 * A product fact is a claim about someone else's software, so each one has to say where it was
 * read and when. These tests hold that line: no sentence without a vendor's page behind it, and no
 * note that quotes a sentence without carrying its source.
 */

/** The documentation sites of the products' own vendors and standards bodies. Nothing else counts. */
const VENDOR_HOSTS = [
  'kafka.apache.org',
  'www.rabbitmq.com',
  'docs.aws.amazon.com',
  'learn.microsoft.com',
  'cloud.google.com',
  'pulsar.apache.org',
  'docs.nats.io',
  'docs.oasis-open.org',
  'redis.io',
  'valkey.io',
  'docs.memcached.org',
];

describe('product facts', () => {
  it('names the vendor page behind every sentence, and the day it was checked', () => {
    for (const fact of OUTAGE_FACTS) {
      expect(fact.holding ?? fact.down, fact.name).toBeTruthy();
      for (const sentence of ['holding', 'down'] as const) {
        // A source for exactly the sentences the fact has: none missing, none left over.
        expect(!!fact.sources[sentence], `${fact.name} ${sentence}`).toBe(!!fact[sentence]);
        const url = fact.sources[sentence];
        if (!url) continue;
        const parsed = new URL(url);
        expect(parsed.protocol, url).toBe('https:');
        expect(VENDOR_HOSTS, url).toContain(parsed.host);
      }
      expect(fact.checked, fact.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(fact.checked)), fact.name).toBe(false);
    }
  });

  it('claims what a product keeps only where it says what the product does meanwhile', () => {
    // `retains` decides whether a topic reads as holding or dropping, so it needs a sentence, and
    // through it a source, to stand on.
    for (const fact of OUTAGE_FACTS) if (fact.retains !== undefined) expect(fact.holding, fact.name).toBeTruthy();
  });

  it('gives a sentence its source, and nothing for a sentence the fact does not have', () => {
    const sqs = outageFact({ type: 'queue', technology: 'Amazon SQS' });
    expect(sourceOf(sqs, 'holding')).toEqual([{ name: 'Amazon SQS', url: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html' }]);
    expect(sourceOf(sqs, 'down')).toBeUndefined();
    expect(sourceOf(null, 'holding')).toBeUndefined();
  });
});

describe('outage notes that quote a product', () => {
  const nodes = [
    node('api', 'service', { text: 'Storefront' }),
    node('cache', 'database', { text: 'Product cache', databaseKind: 'cache', technology: 'Redis' }),
    node('jobs', 'queue', { text: 'Jobs', technology: 'Amazon SQS' }),
    node('plain', 'queue', { text: 'Plain' }),
    node('worker', 'service', { text: 'Worker' }),
    node('other', 'service', { text: 'Other' }),
  ];
  const edges = [
    edge('read', 'api', 'cache', { semantic: 'reads' }),
    edge('put', 'api', 'jobs', { semantic: 'publishes', async: true }),
    edge('take', 'jobs', 'worker', { semantic: 'consumes', async: true }),
    edge('put2', 'api', 'plain', { semantic: 'publishes', async: true }),
    edge('take2', 'plain', 'other', { semantic: 'consumes', async: true }),
  ];
  const read = (target: Parameters<typeof outageOf>[3]) => outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, target)!;

  it('carry the page the sentence was read from', () => {
    const holding = read({ id: 'worker' }).notes.find((note) => note.id === 'holding:jobs');
    expect(holding?.text).toMatch(/Amazon SQS keeps a message for its retention period/);
    expect(holding?.sources).toEqual([{ name: 'Amazon SQS', url: 'https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html' }]);

    const miss = read({ id: 'cache' }).notes.find((note) => note.id.startsWith('cache-miss'));
    expect(miss?.text).toMatch(/Redis saves snapshots to disk by default/);
    expect(miss?.sources?.[0]?.url).toBe('https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/');
  });

  it('carry none where no product is quoted', () => {
    // A queue with no product named, and a cache that is cut off but never restarted.
    expect(read({ id: 'other' }).notes.find((note) => note.id === 'holding:plain')?.sources).toBeUndefined();
    const cut = read({ id: 'read', connector: true }).notes.find((note) => note.id.startsWith('cache-miss'));
    expect(cut?.text).not.toMatch(/Redis/);
    expect(cut?.sources).toBeUndefined();
  });

  it('quote a sentence in every note that has a source, whatever is taken down', () => {
    for (const target of [...nodes.map((item) => ({ id: item.id })), ...edges.map((item) => ({ id: item.id, connector: true }))]) {
      const outage = outageOf(analyzeTraffic({ nodes, edges }), nodes, edges, target);
      for (const note of outage?.notes ?? []) {
        for (const source of note.sources ?? []) {
          const fact = OUTAGE_FACTS.find((item) => item.name === source.name)!;
          expect([fact.holding, fact.down].some((sentence) => !!sentence && note.text.includes(sentence)), note.id).toBe(true);
        }
      }
    }
  });
});
