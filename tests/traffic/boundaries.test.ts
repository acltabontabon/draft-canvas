import { describe, expect, it } from 'vitest';
import { analyzeTraffic } from '../../src/traffic';
import { boundaryCrossings } from '../../src/traffic/boundaries';
import { node, edge } from './helpers';

describe('boundary crossings', () => {
  it('counts normalized routes once through nested boundaries and distinguishes waiting from handoffs', () => {
    const nodes = [node('outer', 'group', { boundaryPreset: 'network' }), node('inner', 'group', { boundaryPreset: 'deployment', parentId: 'outer' }), node('api', 'service'), node('worker', 'service', { parentId: 'inner' }), node('db', 'database', { parentId: 'inner' }), node('queue', 'queue')];
    const edges = [edge('call', 'api', 'worker'), edge('duplicate', 'api', 'worker'), edge('read', 'db', 'api', { semantic: 'reads' }), edge('deliver', 'queue', 'worker', { semantic: 'deliversTo' }), edge('internal', 'worker', 'db', { semantic: 'writes' })];
    const analysis = analyzeTraffic({ nodes, edges });
    const routes = boundaryCrossings(analysis, nodes, { boundaryId: 'outer' });
    expect(routes).toHaveLength(3);
    expect(routes.every((route) => route.direction === 'Incoming')).toBe(true);
    expect(routes.find((route) => route.from === 'api' && route.to === 'db')?.wait).toBe('Waits for response');
    expect(routes.find((route) => route.from === 'queue')?.wait).toBe('Does not wait for downstream work');
    const call = boundaryCrossings(analysis, nodes, { edgeId: 'call' });
    expect(call).toHaveLength(1);
    expect(call[0]!.crossed).toEqual(['inner', 'outer']);
    expect(boundaryCrossings(analysis, nodes, { edgeId: 'internal' })).toEqual([]);
  });
  it('uses membership rather than visual overlap, excludes recovery/structural routes and respects flow scope', () => {
    const nodes = [node('zone', 'group', { boundaryPreset: 'domain' }), node('inside', 'service', { parentId: 'zone' }), node('outside', 'service')];
    const edges = [edge('out', 'inside', 'outside', { async: true, kind: 'conditional' }), edge('comp', 'outside', 'inside', { semantic: 'compensates' }), edge('uses', 'outside', 'inside', { semantic: 'uses' })];
    const analysis = analyzeTraffic({ nodes, edges });
    expect(boundaryCrossings(analysis, nodes, { boundaryId: 'zone' })).toMatchObject([{ direction: 'Outgoing', wait: 'If taken · No synchronous wait drawn' }]);
    expect(boundaryCrossings(analyzeTraffic({ nodes, edges, edgeIds: new Set(['comp']) }), nodes, { boundaryId: 'zone' })).toEqual([]);
    expect(boundaryCrossings(analysis, nodes.map((item) => ({ ...item, parentId: undefined })), { boundaryId: 'zone' })).toEqual([]);
  });
  it('does not invent architectural meaning for plain groups', () => {
    const nodes = [node('group', 'group', { boundaryPreset: 'group' }), node('a', 'service', { parentId: 'group' }), node('b', 'service')];
    const edges = [edge('call', 'a', 'b')];
    expect(boundaryCrossings(analyzeTraffic({ nodes, edges }), nodes, { nodeId: 'a' })).toEqual([]);
  });
});
