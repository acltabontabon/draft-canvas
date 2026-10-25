import { describe, expect, it } from 'vitest';
import { analyzeTraffic } from '../../src/traffic';
import { edge, insight, node, orderIndependentShape } from './helpers';

describe('traffic insight wording and scope', () => {
  it('describes convergence in terms of upstream sources', () => {
    const a = node('a', 'service', { text: 'A' });
    const b = node('b', 'service', { text: 'B' });
    const target = node('target', 'service', { text: 'Target' });
    const result = analyzeTraffic({ nodes: [a, b, target], edges: [edge('a-target', a.id, target.id, { semantic: 'calls' }), edge('b-target', b.id, target.id, { semantic: 'calls' })] });
    expect(insight(result, 'convergence').text).toMatch(/2 separate journeys|2 routes on the same journey/);
  });

  it('does not call mixed data and messaging fan-out targets calls', () => {
    const source = node('source', 'service', { text: 'Source' });
    const service = node('service', 'service', { text: 'Service' });
    const queue = node('queue', 'queue', { queueKind: 'queue', text: 'Queue' });
    const database = node('database', 'database', { databaseKind: 'sql', text: 'Database' });
    const result = analyzeTraffic({ nodes: [source, service, queue, database], edges: [
      edge('source-service', source.id, service.id, { semantic: 'calls' }),
      edge('source-queue', source.id, queue.id, { semantic: 'publishes' }),
      edge('source-database', source.id, database.id, { semantic: 'writes' }),
    ] });
    expect(insight(result, 'fan-out').text).not.toMatch(/calls/);
  });

  it('states the actual number of destinations in a three-way ambiguous split', () => {
    const source = node('source', 'service', { text: 'Source' });
    const junction = node('junction', 'ellipse', { text: 'Junction' });
    const targets = ['a', 'b', 'c'].map((id) => node(id, 'service', { text: id.toUpperCase() }));
    const result = analyzeTraffic({ nodes: [source, junction, ...targets], edges: [
      edge('source-junction', source.id, junction.id, { semantic: 'calls' }),
      ...targets.map((target) => edge(`junction-${target.id}`, junction.id, target.id, { semantic: 'calls' })),
    ] });
    expect(insight(result, 'ambiguous-split').text).toMatch(/\b(3|three)\b/i);
  });

  it('limits not-counted insight to the selected edge scope', () => {
    const a = node('a', 'service');
    const b = node('b', 'service');
    const c = node('c', 'service');
    const selected = edge('selected-failure', a.id, b.id, { semantic: 'calls', kind: 'failure' });
    const omitted = edge('omitted-failure', b.id, c.id, { semantic: 'calls', kind: 'failure' });
    const result = analyzeTraffic({ nodes: [a, b, c], edges: [selected, omitted], edgeIds: new Set([selected.id]) });
    expect(insight(result, 'not-counted').edgeIds).toEqual([selected.id]);
    expect(insight(result, 'not-counted').text).toContain('1 failure path');
    expect(insight(result, 'not-counted').text).not.toContain('omitted');
  });

  it('pluralises two failure paths', () => {
    const a = node('a', 'service');
    const b = node('b', 'service');
    const c = node('c', 'service');
    const first = edge('failure-one', a.id, b.id, { semantic: 'calls', kind: 'failure' });
    const second = edge('failure-two', b.id, c.id, { semantic: 'calls', kind: 'failure' });
    const result = analyzeTraffic({ nodes: [a, b, c], edges: [first, second], edgeIds: new Set([first.id, second.id]) });
    expect(insight(result, 'not-counted').text).toMatch(/2 failure paths/);
  });
});

describe('traffic honesty and determinism', () => {
  it('never claims rates, latency, capacity, saturation or overload', () => {
    const external = node('external', 'service', { serviceKind: 'external', text: 'Payments API' });
    const a = node('a', 'service', { text: 'A' });
    const b = node('b', 'service', { text: 'B' });
    const result = analyzeTraffic({ nodes: [external, a, b], edges: [edge('a-external', a.id, external.id, { semantic: 'calls' }), edge('b-external', b.id, external.id, { semantic: 'calls' })] });
    const text = result.insights.map((value) => value.text.replace(/capacity isn't part of this diagram/gi, '')).join('\n');
    expect(text).not.toMatch(/rps|requests per second|p9\d|p50|latency|overload|saturat|bottleneck|capacity of \d/i);
  });

  it('keeps equal one-path diagrams free of hotspots and reports no concentration', () => {
    const a = node('a', 'service');
    const b = node('b', 'service');
    const c = node('c', 'database', { databaseKind: 'sql' });
    const result = analyzeTraffic({ nodes: [a, b, c], edges: [edge('a-b', a.id, b.id, { semantic: 'calls' }), edge('b-c', b.id, c.id, { semantic: 'reads' })] });
    expect(result.hotspots).toEqual([]);
    expect(insight(result, 'no-concentration').text).toContain('each is reached by one path');
  });

  it('is deterministic for repeated analysis and shuffled nodes and edges', () => {
    const a = node('a', 'service');
    const b = node('b', 'service');
    const c = node('c', 'service');
    const db = node('db', 'database', { databaseKind: 'sql' });
    const edges = [
      edge('a-b', a.id, b.id, { semantic: 'calls' }),
      edge('a-c', a.id, c.id, { semantic: 'calls' }),
      edge('b-db', b.id, db.id, { semantic: 'writes' }),
      edge('c-db', c.id, db.id, { semantic: 'reads' }),
    ];
    const input = { nodes: [a, b, c, db], edges };
    const first = analyzeTraffic(input);
    const second = analyzeTraffic(input);
    expect(first).toEqual(second);

    const shuffled = analyzeTraffic({ nodes: [db, c, a, b], edges: [edges[3]!, edges[1]!, edges[0]!, edges[2]!] });
    expect(orderIndependentShape(shuffled)).toEqual(orderIndependentShape(first));
  });
});
