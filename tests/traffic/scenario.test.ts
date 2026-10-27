import { describe, expect, it } from 'vitest';
import { analyzeTraffic, PATH_CAP } from '../../src/traffic';
import { scenarioRateLabel, trafficScenario } from '../../src/traffic/scenario';
import { edge, node } from './helpers';

describe('illustrative traffic rates', () => {
  it('scales independent entry paths while keeping calls and data operations distinct', () => {
    const analysis = analyzeTraffic({
      nodes: [node('web', 'service'), node('mobile', 'service'), node('api', 'service'), node('db', 'database')],
      edges: [edge('a', 'web', 'api', { semantic: 'calls' }), edge('b', 'mobile', 'api', { semantic: 'calls' }), edge('c', 'api', 'db', { semantic: 'writes' })],
    });
    expect(trafficScenario(analysis).get('web')).toBe('~1,000 starts/min');
    expect(trafficScenario(analysis).get('api')).toBe('~2,000 calls/min');
    expect(trafficScenario(analysis).get('db')).toBe('~2,000 data ops/min');
    expect(analysis.nodes.get('db')!.paths.possible).toBe(2);
  });

  it('copies topic messages but leaves competing queue consumers as ranges', () => {
    const nodes = [node('source', 'service'), node('bus', 'queue', { queueKind: 'topic' }), node('a', 'service'), node('b', 'service')];
    const edges = [edge('p', 'source', 'bus', { semantic: 'publishes' }), edge('a', 'bus', 'a', { semantic: 'deliversTo' }), edge('b', 'bus', 'b', { semantic: 'deliversTo' })];
    expect(trafficScenario(analyzeTraffic({ nodes, edges })).get('a')).toBe('~1,000 messages/min');
    nodes[1] = node('bus', 'queue');
    expect(trafficScenario(analyzeTraffic({ nodes, edges })).get('a')).toBe('0–1,000 messages/min');
  });

  it('does not invent rates for loops or their downstream work', () => {
    const analysis = analyzeTraffic({
      nodes: ['start', 'a', 'b', 'end'].map((id) => node(id, 'service')),
      edges: [edge('s', 'start', 'a'), edge('a', 'a', 'b'), edge('b', 'b', 'a'), edge('e', 'b', 'end')],
    });
    const rates = trafficScenario(analysis);
    expect(rates.get('start')).toBe('~1,000 starts/min');
    expect(rates.get('a')).toBe('Rate unknown');
    expect(rates.get('end')).toBe('Rate unknown');
  });

  it('withholds capped or truncated counts instead of treating them as rates', () => {
    expect(scenarioRateLabel({ definite: 1, possible: PATH_CAP }, 'calls/min')).toBe('Rate unknown');
    const analysis = analyzeTraffic({ nodes: [node('a', 'service'), node('b', 'service')], edges: [edge('ab', 'a', 'b')] });
    expect(trafficScenario({ ...analysis, truncated: true }).get('b')).toBe('Rate unknown');
  });
});
