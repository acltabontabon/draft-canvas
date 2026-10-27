import { describe, expect, it } from 'vitest';
import { analyzeTraffic } from '../../src/traffic';
import { recoveryArrivals, recoveryPlan, recoveryWork } from '../../src/traffic/recovery';
import { trafficScenario } from '../../src/traffic/scenario';
import { edge, node } from './helpers';

function replayFixture() {
  const nodes = [node('api', 'service'), node('worker', 'service'), node('dlq', 'queue', { deliveryRole: 'dead-letter' }), node('db', 'database')];
  const edges = [edge('call', 'api', 'worker'), edge('dead', 'worker', 'dlq', { semantic: 'deadLetters' }), edge('replay', 'dlq', 'worker', { semantic: 'deliversTo' }), edge('write', 'worker', 'db', { semantic: 'writes' })];
  return { nodes, edges };
}

describe('recovery work', () => {
  it('keeps a 500-message replay out of baseline rates and reports batch totals plus shared dependencies', () => {
    const { nodes, edges } = replayFixture();
    const analysis = analyzeTraffic({ nodes, edges });
    const before = trafficScenario(analysis);
    const plan = recoveryPlan(analysis, nodes, edges, 'dlq')!;
    expect(before.get('worker')).toBe('~1,000 calls/min');
    expect(before.has('dlq')).toBe(false);
    expect(analysis.entries).toEqual(['api']);
    expect(recoveryWork(analysis, plan)!.items).toEqual(['1 data operation', '1 message delivery']);
    expect(recoveryWork(analysis, plan, 500)!.items).toEqual(['500 data operations', '500 message deliveries']);
    expect(plan.shared).toEqual(['worker', 'db']);
    expect(recoveryWork(analysis, plan, 0)!.items).toEqual(['Nothing to replay in this example.']);
    expect(recoveryArrivals(analysis, plan, 0).size).toBe(0);
    expect(recoveryArrivals(analysis, plan, 1000).get('db')).toEqual({ definite: 1000, possible: 1000 });
    expect(recoveryArrivals(analysis, plan, 1000).get('worker')).toEqual({ definite: 1000, possible: 1000 });
    expect(trafficScenario(analysis)).toEqual(before);
  });

  it('recognizes recovery-only graphs without inventing an entry or reverse replay path', () => {
    const { nodes, edges } = replayFixture();
    const recoveryEdges = edges.filter((item) => item.id !== 'call');
    const analysis = analyzeTraffic({ nodes: nodes.filter((item) => item.id !== 'api'), edges: recoveryEdges });
    expect(analysis.status).toBe('recovery-only');
    expect(analysis.entries).toEqual([]);
    const noReplayEdges = recoveryEdges.filter((item) => item.id !== 'replay');
    const noReplay = analyzeTraffic({ nodes, edges: noReplayEdges });
    const plan = recoveryPlan(noReplay, nodes, noReplayEdges, 'dlq')!;
    expect(plan.missing).toBe(true);
    expect(recoveryWork(noReplay, plan)!.items).toEqual(['No replay path drawn.']);
  });

  it('uses compensation routes, not the initiator’s normal calls, and keeps completion uncertainty', () => {
    const nodes = ['order', 'payment', 'refund', 'inventory'].map((id) => node(id, 'service'));
    const edges = [edge('pay', 'order', 'payment'), edge('refund', 'order', 'refund', { semantic: 'compensates', compensationFor: 'pay' }), edge('release', 'refund', 'inventory', { semantic: 'compensates' })];
    const analysis = analyzeTraffic({ nodes, edges });
    const plan = recoveryPlan(analysis, nodes, edges, 'order')!;
    expect(plan.targets).toEqual(['refund']);
    expect(recoveryWork(analysis, plan)!.items).toEqual(['0–2 downstream calls']);
    expect(trafficScenario(analysis).has('refund')).toBe(false);
    expect(recoveryPlan(analysis, nodes, edges, 'payment')).toBeNull();
  });

  it('does not treat a fallback as compensation or follow an excluded flow', () => {
    const nodes = ['a', 'b', 'c'].map((id) => node(id, 'service'));
    const edges = [edge('fallback', 'a', 'b', { kind: 'fallback' }), edge('comp', 'a', 'c', { semantic: 'compensates' })];
    const analysis = analyzeTraffic({ nodes, edges, edgeIds: new Set(['fallback']) });
    expect(recoveryPlan(analysis, nodes, edges, 'a')).toBeNull();
  });

  it('withholds totals for loops and truncation, and rejects invalid pending counts', () => {
    const { nodes, edges } = replayFixture();
    edges.push(edge('loop', 'worker', 'worker'));
    const analysis = analyzeTraffic({ nodes, edges });
    const plan = recoveryPlan(analysis, nodes, edges, 'dlq')!;
    expect(recoveryWork(analysis, plan, 500)!.unknown).toBe(true);
    expect(recoveryArrivals(analysis, plan, 500).size).toBe(0);
    expect(recoveryWork({ ...analysis, truncated: true }, plan)!.unknown).toBe(true);
    for (const count of [-1, 1.5, NaN, Infinity, 1_000_001]) expect(recoveryWork(analysis, plan, count)).toBeNull();
  });
});
