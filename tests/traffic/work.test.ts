import { describe, expect, it } from 'vitest';
import { analyzeTraffic } from '../../src/traffic';
import { rateBreakdown, workPerArrival } from '../../src/traffic/work';
import { edge, node } from './helpers';

describe('traffic explanations', () => {
  it('breaks down incoming rates without mixing workloads under the fixed example rate', () => {
    const analysis = analyzeTraffic({ nodes: [node('a', 'service'), node('b', 'service'), node('db', 'database')], edges: [edge('a', 'a', 'db', { semantic: 'reads' }), edge('b', 'b', 'db', { semantic: 'writes' })] });
    expect(rateBreakdown(analysis, 'db')).toEqual([{ from: 'a', rate: '~1,000 data ops/min' }, { from: 'b', rate: '~1,000 data ops/min' }]);
  });

  it('counts converging work per arrival here, independent of other upstream entries', () => {
    const analysis = analyzeTraffic({
      nodes: ['entry1', 'entry2', 'checkout', 'a', 'b', 'merged'].map((id) => node(id, 'service')).concat(node('db', 'database')),
      edges: [edge('e1', 'entry1', 'checkout'), edge('e2', 'entry2', 'checkout'), edge('a', 'checkout', 'a'), edge('b', 'checkout', 'b'), edge('am', 'a', 'merged'), edge('bm', 'b', 'merged'), edge('db', 'merged', 'db', { semantic: 'writes' })],
    });
    expect(workPerArrival(analysis, 'checkout').items).toEqual(['4 downstream calls', '2 data operations']);
    expect(workPerArrival(analysis, 'db').items).toEqual(['No downstream work drawn.']);
  });

  it('distinguishes publishing a message from delivering copies to subscribers', () => {
    const analysis = analyzeTraffic({ nodes: [node('api', 'service'), node('topic', 'queue', { queueKind: 'topic' }), node('a', 'service'), node('b', 'service')], edges: [edge('p', 'api', 'topic', { semantic: 'publishes' }), edge('a', 'topic', 'a', { semantic: 'deliversTo' }), edge('b', 'topic', 'b', { semantic: 'deliversTo' })] });
    expect(workPerArrival(analysis, 'api').items).toEqual(['1 message published', '2 message deliveries']);
  });

  it('propagates uncertainty and excludes retries from the baseline', () => {
    const analysis = analyzeTraffic({ nodes: [node('api', 'service'), node('worker', 'service'), node('db', 'database')], edges: [edge('conditional', 'api', 'worker', { kind: 'conditional' }), edge('db', 'worker', 'db', { semantic: 'writes' }), edge('retry', 'worker', 'api', { kind: 'retry' })] });
    expect(workPerArrival(analysis, 'api')).toEqual({ items: ['0–1 downstream call', '0–1 data operation'], uncertain: true, unknown: false });
    expect(rateBreakdown(analysis, 'worker')[0]!.rate).toBe('0–1,000 calls/min');
  });

  it('withholds loop and truncated totals, without letting an unrelated loop spoil another journey', () => {
    const analysis = analyzeTraffic({ nodes: ['entry', 'a', 'b', 'safe', 'end'].map((id) => node(id, 'service')), edges: [edge('e', 'entry', 'a'), edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('safe', 'safe', 'end')] });
    expect(workPerArrival(analysis, 'entry').unknown).toBe(true);
    expect(workPerArrival(analysis, 'safe').items).toEqual(['1 downstream call']);
    expect(workPerArrival({ ...analysis, truncated: true }, 'safe').unknown).toBe(true);
    expect(rateBreakdown(analysis, 'b')[0]!.rate).toBe('Rate unknown');
  });
});
